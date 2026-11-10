import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import { samplePdf, sampleOgg } from './support/sample-files.js';

/**
 * Pruebas HTTP reales: la aplicación escucha en un puerto TCP local y se
 * usa `fetch` con `FormData` (multipart real), como lo hará el frontend o
 * n8n. Base PGlite y almacenamiento temporal aislado: nada se escribe en Neon.
 */
describe('Ingestion over real HTTP (local server)', () => {
  let w: ProcessWorld;
  let base: string;
  const { sql, drainQueue, claim } = processHelpers(() => w);
  const PASSWORD = 'contraseña-de-prueba-123';

  const form = (
    file: Buffer,
    name: string,
    type: string,
    fields: Record<string, string> = {},
  ) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    body.append('file', new Blob([new Uint8Array(file)], { type }), name);
    return body;
  };

  const login = async (email: string) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    w = await createProcessWorld();
    // Usuarios con credenciales conocidas para el login real.
    const { createTestUser } = await import('./support/pglite.js');
    await createTestUser(w.t.db, {
      email: 'http.a@notihouse.test',
      password: PASSWORD,
      displayName: 'A',
    });
    await createTestUser(w.t.db, {
      email: 'http.b@notihouse.test',
      password: PASSWORD,
      displayName: 'B',
    });
    await w.h.app.listen(0, '127.0.0.1');
    const { port } = w.h.app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}/api/v1`;
  }, 60_000);

  afterAll(async () => {
    await w.h.app.close();
    await w.t.client.close();
  });

  it('runs the full ingestion flow over HTTP', async () => {
    await drainQueue();
    // 1. Login real.
    const tokenA = await login('http.a@notihouse.test');
    const tokenB = await login('http.b@notihouse.test');
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const finance = await sql(
      'SELECT id, status, updated_at FROM rent_charges ORDER BY id',
    );
    const occurrences = await sql(
      'SELECT id, status, updated_at FROM obligation_occurrences ORDER BY id',
    );

    // 2. PDF válido.
    const pdfBytes = samplePdf(`HTTP ${randomUUID()}`);
    const requestId = randomUUID();
    const upload = await fetch(`${base}/ingestions/documents`, {
      method: 'POST',
      headers: auth(tokenA),
      body: form(pdfBytes, 'factura.pdf', 'application/pdf', { requestId }),
    });
    expect(upload.status).toBe(201);
    const doc = (await upload.json()) as { documentId: string; caseId: string };

    // 3. PDF inválido.
    const bad = await fetch(`${base}/ingestions/documents`, {
      method: 'POST',
      headers: auth(tokenA),
      body: form(
        Buffer.from('<html></html>'),
        'factura.pdf',
        'application/pdf',
      ),
    });
    expect(bad.status).toBe(415);

    // 4. Audio válido y 5. audio inválido.
    const voice = await fetch(`${base}/ingestions/voice`, {
      method: 'POST',
      headers: auth(tokenA),
      body: form(sampleOgg(), 'nota.ogg', 'audio/ogg'),
    });
    expect(voice.status).toBe(201);
    const badVoice = await fetch(`${base}/ingestions/voice`, {
      method: 'POST',
      headers: auth(tokenA),
      body: form(pdfBytes, 'nota.ogg', 'audio/ogg'),
    });
    expect(badVoice.status).toBe(415);

    // 6. Consulta y 7. descarga autenticada.
    const meta = await fetch(`${base}/documents/${doc.documentId}`, {
      headers: auth(tokenA),
    });
    expect(meta.status).toBe(200);
    const content = await fetch(`${base}/documents/${doc.documentId}/content`, {
      headers: auth(tokenA),
    });
    expect(content.status).toBe(200);
    expect(content.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(pdfBytes);

    // 8. Usuario ajeno.
    const foreign = await fetch(`${base}/documents/${doc.documentId}/content`, {
      headers: auth(tokenB),
    });
    expect(foreign.status).toBe(404);

    // 9. Worker no autorizado (sin token, con JWT de usuario, sin reclamación).
    const internal = `${base}/internal/documents/${doc.documentId}/content`;
    expect((await fetch(internal)).status).toBe(401);
    expect((await fetch(internal, { headers: auth(tokenA) })).status).toBe(401);
    expect(
      (await fetch(internal, { headers: auth(process.env.N8N_SERVICE_TOKEN!) }))
        .status,
    ).toBe(400);
    // …y autorizado con la reclamación de su trabajo.
    const jobs = await claim('worker-http', { jobTypes: ['document.process'] });
    const job = jobs.find((j) => j.case.id === doc.caseId)!;
    const workerRead = await fetch(internal, {
      headers: {
        ...auth(process.env.N8N_SERVICE_TOKEN!),
        'X-Job-Id': job.id,
        'X-Claim-Token': job.claimToken,
      },
    });
    expect(workerRead.status).toBe(200);
    expect(Buffer.from(await workerRead.arrayBuffer())).toEqual(pdfBytes);

    // 10. Idempotencia.
    const retry = await fetch(`${base}/ingestions/documents`, {
      method: 'POST',
      headers: auth(tokenA),
      body: form(pdfBytes, 'factura.pdf', 'application/pdf', { requestId }),
    });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { documentId: string }).documentId).toBe(
      doc.documentId,
    );

    // 11. Casos y trabajos generados.
    const cases = (await (
      await fetch(`${base}/cases`, { headers: auth(tokenA) })
    ).json()) as {
      items: { source: string }[];
    };
    expect(cases.items.map((c) => c.source).sort()).toEqual([
      'document',
      'voice',
    ]);
    const jobTypes = (
      await sql<{ job_type: string }>(
        `SELECT j.job_type FROM workflow_jobs j JOIN cases c ON c.id = j.case_id
          JOIN auth_accounts a ON a.profile_id = c.owner_id
         WHERE a.email = 'http.a@notihouse.test' ORDER BY 1`,
      )
    ).map((r) => r.job_type);
    expect(jobTypes).toEqual(['document.process', 'voice.transcribe']);

    // 12. Ninguna escritura financiera.
    expect(
      await sql('SELECT id, status, updated_at FROM rent_charges ORDER BY id'),
    ).toEqual(finance);
    expect(
      await sql(
        'SELECT id, status, updated_at FROM obligation_occurrences ORDER BY id',
      ),
    ).toEqual(occurrences);
  });
});
