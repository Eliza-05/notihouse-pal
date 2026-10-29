import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { TestUser } from './support/pglite.js';
import {
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import {
  AUDIO_SAMPLES,
  pdfWithJavaScript,
  fixture,
  samplePdf,
  sampleWav,
  truncatedPdf,
} from './support/sample-files.js';

/**
 * Ingesta de facturas PDF y notas de voz sobre PGlite y un directorio de
 * almacenamiento temporal aislado: validación del archivo, caso + documento
 * + trabajo + auditoría, idempotencia y documentos privados.
 */
describe('Document and voice ingestion (e2e)', () => {
  let w: ProcessWorld;
  const { sql } = processHelpers(() => w);
  const STORAGE = process.env.STORAGE_LOCAL_PATH!;
  const UPLOADS = process.env.STORAGE_UPLOAD_TMP_PATH!;

  const sha256 = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex');

  /** Archivos presentes bajo un directorio (vacío si aún no existe). */
  const filesUnder = async (dir: string) => {
    try {
      const entries = await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      });
      return entries
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name));
    } catch {
      return [];
    }
  };

  const counts = async () =>
    (
      await sql<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM documents) AS documents,
                (SELECT count(*)::int FROM cases) AS cases,
                (SELECT count(*)::int FROM workflow_jobs) AS jobs`,
      )
    )[0]!;

  const upload = (
    user: TestUser | null,
    route: 'documents' | 'voice',
    file: { bytes: Buffer; name: string; mime: string } | null,
    fields: Record<string, string> = {},
  ) => {
    let req = request(w.h.app.getHttpServer()).post(
      `/api/v1/ingestions/${route}`,
    );
    if (user) req = req.set('Authorization', `Bearer ${w.h.tokenFor(user)}`);
    for (const [key, value] of Object.entries(fields))
      req = req.field(key, value);
    if (file) {
      req = req.attach('file', file.bytes, {
        filename: file.name,
        contentType: file.mime,
      });
    }
    return req;
  };

  const pdf = (body?: string) => ({
    bytes: samplePdf(body ?? `Factura ${randomUUID()}`),
    name: 'factura-noviembre.pdf',
    mime: 'application/pdf',
  });

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);

  afterAll(async () => {
    await w.h.app.close();
    await w.t.client.close();
  });

  afterEach(async () => {
    // Ningún temporal de recepción sobrevive a una solicitud.
    expect(await filesUnder(UPLOADS)).toEqual([]);
  });

  describe('PDF invoices', () => {
    it('requires a valid JWT before receiving any byte', async () => {
      const before = await filesUnder(STORAGE);
      await upload(null, 'documents', pdf()).expect(401);
      await request(w.h.app.getHttpServer())
        .post('/api/v1/ingestions/documents')
        .set('Authorization', 'Bearer not-a-jwt')
        .attach('file', samplePdf(), {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .expect(401);
      await request(w.h.app.getHttpServer())
        .post('/api/v1/ingestions/documents')
        .set('Authorization', `Bearer ${process.env.N8N_SERVICE_TOKEN}`)
        .attach('file', samplePdf(), {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .expect(401);
      expect(await filesUnder(STORAGE)).toEqual(before);
    });

    it('stores the PDF privately and creates document, case, job and audit atomically', async () => {
      const file = pdf();
      const res = await upload(w.laura, 'documents', file, {
        obligationId: w.lauraObligation,
      }).expect(201);
      expect(res.body).toMatchObject({
        caseStatus: 'received',
        source: 'document',
        documentType: 'invoice',
        mimeType: 'application/pdf',
        sha256: sha256(file.bytes),
        sizeBytes: file.bytes.length,
        job: { type: 'document.process', status: 'pending' },
        processing: 'pending',
        duplicateContent: false,
      });
      expect(res.headers['x-correlation-id']).toBe(res.body.correlationId);
      expect(JSON.stringify(res.body)).not.toMatch(/storage|ownerId|\.local/i);

      const [doc] = await sql<Record<string, unknown>>(
        'SELECT * FROM documents WHERE id = $1',
        [res.body.documentId],
      );
      expect(doc).toMatchObject({
        owner_id: w.laura.profileId,
        case_id: res.body.caseId,
        type: 'invoice',
        source: 'document',
        mime_type: 'application/pdf',
        file_name: 'factura-noviembre.pdf',
        sha256: sha256(file.bytes),
        external_message_id: null,
      });
      expect(doc!.storage_key).toMatch(
        /^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/,
      );
      const stored = join(STORAGE, ...(doc!.storage_key as string).split('/'));
      expect(await readFile(stored)).toEqual(file.bytes);

      const [caseRow] = await sql<Record<string, unknown>>(
        'SELECT source, type, status, obligation_id, correlation_id FROM cases WHERE id = $1',
        [res.body.caseId],
      );
      expect(caseRow).toMatchObject({
        source: 'document',
        type: 'household_obligation',
        status: 'received',
        obligation_id: w.lauraObligation,
        correlation_id: res.body.correlationId,
      });
      const [job] = await sql<Record<string, unknown>>(
        'SELECT job_type, status, payload FROM workflow_jobs WHERE case_id = $1',
        [res.body.caseId],
      );
      expect(job).toMatchObject({
        job_type: 'document.process',
        status: 'pending',
        payload: {
          documentId: res.body.documentId,
          documentType: 'invoice',
          mimeType: 'application/pdf',
          sizeBytes: file.bytes.length,
          obligationId: w.lauraObligation,
        },
      });
      const actions = (
        await sql<{ action: string; actor_id: string }>(
          'SELECT action, actor_id FROM audit_events WHERE correlation_id = $1',
          [res.body.correlationId],
        )
      ).map((e) => e.action);
      expect(actions.sort()).toEqual([
        'case.create',
        'document.receive',
        'workflow_job.create',
      ]);
      // La auditoría no contiene el contenido del PDF.
      const audit = await sql(
        'SELECT metadata FROM audit_events WHERE correlation_id = $1',
        [res.body.correlationId],
      );
      expect(JSON.stringify(audit)).not.toContain('Factura');
    });

    it('associates contracts to contract review cases', async () => {
      const res = await upload(w.camila, 'documents', pdf(), {
        documentType: 'contract',
        contractId: w.camilaContract,
      }).expect(201);
      const [row] = await sql<Record<string, unknown>>(
        'SELECT type, contract_id FROM cases WHERE id = $1',
        [res.body.caseId],
      );
      expect(row).toEqual({
        type: 'contract_review',
        contract_id: w.camilaContract,
      });
      await upload(w.camila, 'documents', pdf(), {
        documentType: 'contract',
        obligationId: w.lauraObligation,
      }).expect(400);
    });

    it('rejects references to resources of other owners without storing anything', async () => {
      const before = { files: await filesUnder(STORAGE), rows: await counts() };
      await upload(w.andres, 'documents', pdf(), {
        obligationId: w.lauraObligation,
      }).expect(404);
      await upload(w.laura, 'documents', pdf(), {
        documentType: 'contract',
        contractId: w.camilaContract,
      }).expect(404);
      expect(await filesUnder(STORAGE)).toEqual(before.files);
      expect(await counts()).toEqual(before.rows);
    });

    it.each([
      [
        'an empty file',
        { bytes: Buffer.alloc(0), name: 'a.pdf', mime: 'application/pdf' },
        {},
        400,
      ],
      [
        'a file over the limit',
        {
          bytes: Buffer.concat([samplePdf(), Buffer.alloc(70 * 1024)]),
          name: 'a.pdf',
          mime: 'application/pdf',
        },
        {},
        413,
      ],
      [
        'a wrong extension',
        { bytes: samplePdf(), name: 'a.txt', mime: 'application/pdf' },
        {},
        415,
      ],
      [
        'a wrong MIME',
        { bytes: samplePdf(), name: 'a.pdf', mime: 'text/html' },
        {},
        415,
      ],
      [
        'HTML disguised as PDF',
        {
          bytes: Buffer.from('<html><script>alert(1)</script></html>'),
          name: 'a.pdf',
          mime: 'application/pdf',
        },
        {},
        415,
      ],
      [
        'an SVG',
        {
          bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          name: 'a.svg',
          mime: 'image/svg+xml',
        },
        {},
        415,
      ],
      [
        'a truncated PDF',
        { bytes: truncatedPdf(), name: 'a.pdf', mime: 'application/pdf' },
        {},
        400,
      ],
      [
        'a PDF with JavaScript',
        { bytes: pdfWithJavaScript(), name: 'a.pdf', mime: 'application/pdf' },
        {},
        415,
      ],
      [
        'an audio file',
        { bytes: sampleWav(), name: 'a.wav', mime: 'audio/wav' },
        {},
        415,
      ],
      ['a client ownerId', null, { ownerId: randomUUID() }, 400],
      [
        'a propertyId (not supported by the schema)',
        null,
        { propertyId: randomUUID() },
        400,
      ],
      ['a client storage key', null, { storageKey: '../../etc/passwd' }, 400],
      ['an unknown document type', null, { documentType: 'voice_note' }, 400],
      ['a malformed requestId', null, { requestId: 'abc' }, 400],
    ])(
      'rejects %s without writing anything',
      async (_c, file, fields, status) => {
        const before = {
          files: await filesUnder(STORAGE),
          rows: await counts(),
        };
        await upload(
          w.laura,
          'documents',
          file ?? pdf(),
          fields as Record<string, string>,
        ).expect(status as number);
        expect(await filesUnder(STORAGE)).toEqual(before.files);
        expect(await counts()).toEqual(before.rows);
      },
    );

    it('rejects missing files, extra files, wrong fields and non-multipart bodies', async () => {
      const before = await counts();
      await upload(w.laura, 'documents', null).expect(400);
      const auth = `Bearer ${w.h.tokenFor(w.laura)}`;
      const server = w.h.app.getHttpServer();
      await request(server)
        .post('/api/v1/ingestions/documents')
        .set('Authorization', auth)
        .attach('file', samplePdf(), {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .attach('file', samplePdf(), {
          filename: 'b.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);
      await request(server)
        .post('/api/v1/ingestions/documents')
        .set('Authorization', auth)
        .attach('document', samplePdf(), {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);
      await request(server)
        .post('/api/v1/ingestions/documents')
        .set('Authorization', auth)
        .send({ file: samplePdf().toString('base64') })
        .expect(400);
      await request(server)
        .post('/api/v1/ingestions/documents')
        .set('Authorization', auth)
        .field('requestId', 'x'.repeat(300))
        .attach('file', samplePdf(), {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);
      expect(await counts()).toEqual(before);
    });
  });

  describe('idempotency and duplicates', () => {
    it('returns the existing ingestion for a repeated request (e.g. after a timeout)', async () => {
      const requestId = randomUUID();
      const file = pdf();
      const first = await upload(w.laura, 'documents', file, {
        requestId,
      }).expect(201);
      const filesAfterFirst = await filesUnder(STORAGE);
      const retry = await upload(w.laura, 'documents', file, {
        requestId,
      }).expect(200);
      expect(retry.body).toMatchObject({
        documentId: first.body.documentId,
        caseId: first.body.caseId,
        correlationId: first.body.correlationId,
        sizeBytes: file.bytes.length,
      });
      expect(await filesUnder(STORAGE)).toEqual(filesAfterFirst);

      await upload(w.laura, 'documents', pdf(), { requestId }).expect(409);
      await upload(w.laura, 'documents', file, {
        requestId,
        documentType: 'payment_receipt',
      }).expect(409);
    });

    it('creates a single ingestion for concurrent requests with the same key', async () => {
      const requestId = randomUUID();
      const file = pdf();
      const before = await filesUnder(STORAGE);
      const responses = await Promise.all(
        // Dos simultáneas: el máximo por usuario (una tercera recibiría 429).
        [1, 2].map(() => upload(w.laura, 'documents', file, { requestId })),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
      expect(new Set(responses.map((r) => r.body.documentId)).size).toBe(1);
      // Los objetos de las solicitudes perdedoras se retiraron (compensación).
      expect((await filesUnder(STORAGE)).length).toBe(before.length + 1);
      const docs = await sql('SELECT 1 FROM documents WHERE sha256 = $1', [
        sha256(file.bytes),
      ]);
      expect(docs).toHaveLength(1);
    });

    it('keeps identical content private per user and flags intentional re-uploads', async () => {
      const file = pdf('Contenido idéntico');
      const laura = await upload(w.laura, 'documents', file).expect(201);
      const andres = await upload(w.andres, 'documents', file).expect(201);
      expect(andres.body.documentId).not.toBe(laura.body.documentId);
      expect(andres.body.duplicateContent).toBe(false);
      await w.h
        .as(w.andres)
        .get(`/documents/${laura.body.documentId}`)
        .expect(404);

      // El mismo usuario lo vuelve a cargar a propósito: nuevo caso, marcado.
      const again = await upload(w.laura, 'documents', file).expect(201);
      expect(again.body.caseId).not.toBe(laura.body.caseId);
      expect(again.body.duplicateContent).toBe(true);
      // La misma clave en otro usuario es independiente.
      const requestId = randomUUID();
      await upload(w.laura, 'documents', pdf(), { requestId }).expect(201);
      await upload(w.andres, 'documents', pdf(), { requestId }).expect(201);
    });
  });

  describe('voice notes', () => {
    it.each(Object.entries(AUDIO_SAMPLES))(
      'accepts a %s note and queues its future transcription',
      async (format, sample) => {
        const bytes = sample.bytes();
        const res = await upload(w.andres, 'voice', {
          bytes,
          name: sample.name,
          mime: sample.mime,
        }).expect(201);
        expect(res.body).toMatchObject({
          source: 'voice',
          documentType: 'voice_note',
          job: { type: 'voice.transcribe', status: 'pending' },
          processing: 'pending',
          sha256: sha256(bytes),
        });
        const [doc] = await sql<Record<string, unknown>>(
          'SELECT owner_id, storage_key, mime_type FROM documents WHERE id = $1',
          [res.body.documentId],
        );
        expect(doc!.owner_id).toBe(w.andres.profileId);
        expect(doc!.storage_key).toMatch(/^voice\//);
        expect(doc!.mime_type).toMatch(new RegExp(`^audio/`));
        // Sin transcripción inventada: no hay propuestas ni HITL.
        const proposals = await sql(
          'SELECT 1 FROM case_proposals WHERE case_id = $1',
          [res.body.caseId],
        );
        expect(proposals).toEqual([]);
        expect(format).toBeTruthy();
      },
    );

    it.each([
      ['voice-m4a-brand.m4a', 'audio/mp4'],
      ['voice-isom.m4a', 'audio/x-m4a'],
      ['voice-mp42.m4a', 'audio/mp4'],
      ['voice-vorbis.ogg', 'audio/ogg'],
    ])('accepts the real recording %s', async (name, mime) => {
      const res = await upload(w.andres, 'voice', {
        bytes: fixture(name),
        name: name.endsWith('.m4a') ? 'nota.m4a' : 'nota.ogg',
        mime,
      }).expect(201);
      expect(res.body.job).toEqual({
        type: 'voice.transcribe',
        status: 'pending',
      });
    });

    it.each([
      ['WebM with video', 'av.webm', 'nota.webm', 'audio/webm', 415],
      [
        'WebM with only video',
        'video-only.webm',
        'nota.webm',
        'audio/webm',
        415,
      ],
      ['MP4 with only video', 'video-only.mp4', 'nota.m4a', 'audio/mp4', 415],
      ['MP4 with audio and video', 'av.mp4', 'nota.m4a', 'audio/mp4', 415],
      ['Ogg Theora video', 'video-theora.ogg', 'nota.ogg', 'audio/ogg', 415],
    ])(
      'rejects %s and leaves no temporary file',
      async (_c, name, file, mime, status) => {
        const before = {
          files: await filesUnder(STORAGE),
          rows: await counts(),
        };
        await upload(w.andres, 'voice', {
          bytes: fixture(name),
          name: file,
          mime,
        }).expect(status);
        expect(await filesUnder(STORAGE)).toEqual(before.files);
        expect(await counts()).toEqual(before.rows);
        expect(await filesUnder(UPLOADS)).toEqual([]);
      },
    );

    it.each([
      ['voice-isom.m4a', 'nota.m4a', 'audio/mp4'],
      ['voice-opus.webm', 'nota.webm', 'audio/webm'],
      ['voice-opus.ogg', 'nota.ogg', 'audio/ogg'],
      ['voice.mp3', 'nota.mp3', 'audio/mpeg'],
      ['voice.wav', 'nota.wav', 'audio/wav'],
    ])('rejects a truncated %s (400)', async (name, file, mime) => {
      const bytes = fixture(name);
      const before = await counts();
      await upload(w.andres, 'voice', {
        bytes: bytes.subarray(0, Math.floor(bytes.length * 0.6)),
        name: file,
        mime,
      }).expect(400);
      expect(await counts()).toEqual(before);
    });

    it('rejects random content with an audio name and type', async () => {
      const random = Buffer.from(
        Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251),
      );
      await upload(w.andres, 'voice', {
        bytes: random,
        name: 'nota.mp3',
        mime: 'audio/mpeg',
      }).expect(415);
      await upload(w.andres, 'voice', {
        bytes: fixture('voice-opus.ogg'),
        name: 'nota.ogg',
        mime: 'audio/webm',
      }).expect(415);
    });

    it('uses an own rental as context and rejects a foreign one', async () => {
      const ok = await upload(
        w.andres,
        'voice',
        { bytes: sampleWav(), name: 'nota.wav', mime: 'audio/wav' },
        { caseType: 'rent_collection', rentalId: w.andresRental },
      ).expect(201);
      const [row] = await sql<{ rental_id: string; type: string }>(
        'SELECT rental_id, type FROM cases WHERE id = $1',
        [ok.body.caseId],
      );
      expect(row).toEqual({
        rental_id: w.andresRental,
        type: 'rent_collection',
      });
      await upload(
        w.laura,
        'voice',
        { bytes: sampleWav(), name: 'nota.wav', mime: 'audio/wav' },
        { caseType: 'rent_collection', rentalId: w.andresRental },
      ).expect(404);
    });

    it.each([
      [
        'a mislabeled file',
        { bytes: sampleWav(), name: 'nota.mp3', mime: 'audio/mpeg' },
        415,
      ],
      [
        'a generic MP4 video',
        {
          bytes: fixture('video-only.mp4'),
          name: 'nota.m4a',
          mime: 'audio/mp4',
        },
        415,
      ],
      [
        'a PDF',
        { bytes: samplePdf(), name: 'nota.pdf', mime: 'application/pdf' },
        415,
      ],
      [
        'an empty file',
        { bytes: Buffer.alloc(0), name: 'nota.wav', mime: 'audio/wav' },
        400,
      ],
      [
        'a file over the limit',
        {
          bytes: Buffer.concat([sampleWav(), Buffer.alloc(130 * 1024)]),
          name: 'nota.wav',
          mime: 'audio/wav',
        },
        413,
      ],
    ])('rejects %s', async (_c, file, status) => {
      const before = await counts();
      await upload(w.andres, 'voice', file).expect(status);
      expect(await counts()).toEqual(before);
    });

    it('deduplicates retried uploads and never touches financial data', async () => {
      const requestId = randomUUID();
      const file = { bytes: sampleWav(), name: 'nota.wav', mime: 'audio/wav' };
      const chargeBefore = await sql(
        'SELECT status, confirmed_at, updated_at FROM rent_charges WHERE id = $1',
        [w.andresCharge],
      );
      const obligationsBefore = await sql(
        'SELECT id, updated_at FROM obligations ORDER BY id',
      );
      const first = await upload(w.andres, 'voice', file, { requestId }).expect(
        201,
      );
      const again = await upload(w.andres, 'voice', file, { requestId }).expect(
        200,
      );
      expect(again.body.caseId).toBe(first.body.caseId);
      const jobs = await sql('SELECT 1 FROM workflow_jobs WHERE case_id = $1', [
        first.body.caseId,
      ]);
      expect(jobs).toHaveLength(1);
      expect(
        await sql(
          'SELECT status, confirmed_at, updated_at FROM rent_charges WHERE id = $1',
          [w.andresCharge],
        ),
      ).toEqual(chargeBefore);
      expect(
        await sql('SELECT id, updated_at FROM obligations ORDER BY id'),
      ).toEqual(obligationsBefore);
    });
  });

  describe('private documents', () => {
    it('lists only own documents with filters and pagination', async () => {
      const voice = await upload(w.camila, 'voice', {
        bytes: sampleWav(),
        name: 'nota.wav',
        mime: 'audio/wav',
      }).expect(201);
      await upload(w.camila, 'documents', pdf()).expect(201);
      const all = (await w.h.as(w.camila).get('/documents').expect(200)).body;
      expect(all.total).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(all)).not.toMatch(/storageKey|storage_key|ownerId/);
      const owned = await sql<{ n: number }>(
        'SELECT count(*)::int AS n FROM documents WHERE owner_id = $1',
        [w.camila.profileId],
      );
      expect(all.total).toBe(owned[0]!.n);

      const voices = (
        await w.h.as(w.camila).get('/documents?type=voice_note').expect(200)
      ).body;
      expect(
        voices.items.every((d: { type: string }) => d.type === 'voice_note'),
      ).toBe(true);
      const byCase = (
        await w.h
          .as(w.camila)
          .get(`/documents?caseId=${voice.body.caseId}`)
          .expect(200)
      ).body;
      expect(byCase.items.map((d: { id: string }) => d.id)).toEqual([
        voice.body.documentId,
      ]);
      expect(
        (await w.h.as(w.camila).get('/documents?pageSize=1').expect(200)).body
          .items,
      ).toHaveLength(1);
      await w.h.as(w.camila).get('/documents?type=invoice2').expect(400);
    });

    it('downloads own content as an attachment with safe headers', async () => {
      const file = pdf();
      const up = await upload(w.laura, 'documents', file).expect(201);
      const meta = (
        await w.h
          .as(w.laura)
          .get(`/documents/${up.body.documentId}`)
          .expect(200)
      ).body;
      expect(meta).toMatchObject({
        id: up.body.documentId,
        caseId: up.body.caseId,
        fileName: 'factura-noviembre.pdf',
        mimeType: 'application/pdf',
      });
      expect(meta).not.toHaveProperty('storageKey');

      const res = await w.h
        .as(w.laura)
        .get(`/documents/${up.body.documentId}/content`)
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (c: Buffer) => chunks.push(c));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.body).toEqual(file.bytes);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="factura-noviembre\.pdf"/,
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['content-security-policy']).toContain('sandbox');
    });

    it('hides foreign and nonexistent documents (404)', async () => {
      const up = await upload(w.laura, 'documents', pdf()).expect(201);
      await w.h
        .as(w.andres)
        .get(`/documents/${up.body.documentId}`)
        .expect(404);
      await w.h
        .as(w.andres)
        .get(`/documents/${up.body.documentId}/content`)
        .expect(404);
      await w.h
        .as(w.laura)
        .get(`/documents/${randomUUID()}/content`)
        .expect(404);
      await w.h.as(w.laura).get('/documents/not-a-uuid').expect(400);
      await request(w.h.app.getHttpServer())
        .get(`/api/v1/documents/${up.body.documentId}/content`)
        .expect(401);
    });

    it('exposes no public route to the storage directory', async () => {
      const [doc] = await sql<{ storage_key: string }>(
        'SELECT storage_key FROM documents LIMIT 1',
      );
      const server = w.h.app.getHttpServer();
      for (const path of [
        `/${doc!.storage_key}`,
        `/storage/${doc!.storage_key}`,
        `/.local/storage/${doc!.storage_key}`,
        `/api/v1/${doc!.storage_key}`,
        '/api/v1/documents/../storage',
      ]) {
        const res = await request(server).get(path);
        expect([401, 404]).toContain(res.status);
        expect(res.headers['content-type'] ?? '').not.toContain(
          'application/pdf',
        );
      }
      // No hay DELETE de documentos.
      await request(server)
        .delete(`/api/v1/documents/${randomUUID()}`)
        .set('Authorization', `Bearer ${w.h.tokenFor(w.laura)}`)
        .expect(404);
    });
  });
});
