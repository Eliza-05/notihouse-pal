import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AuditService } from '../../src/audit/audit.service.js';
import {
  FILE_STORAGE,
  type FileStorage,
  type StoredObject,
} from '../../src/storage/file-storage.js';
import { LocalFileStorage } from '../../src/storage/local-file-storage.js';
import { samplePdf, sampleWav } from '../support/sample-files.js';
import {
  type Api,
  type ClaimedJob,
  Harness,
  httpClient,
  recordEvidence,
  type Res,
  startApi,
  statuses,
} from './support/harness.js';

const DOCS = '/ingestions/documents';
const VOICE = '/ingestions/voice';
const pdf = (body?: string) => ({
  name: 'factura.pdf',
  type: 'application/pdf',
  bytes: samplePdf(body),
});
const wav = () => ({
  name: 'nota.wav',
  type: 'audio/wav',
  bytes: sampleWav(),
});

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      )
    : [];
const storedFiles = () => walk(process.env.STORAGE_LOCAL_PATH!);
const tempFiles = () => walk(process.env.STORAGE_UPLOAD_TMP_PATH!);

/** Fallos controlados de almacenamiento y auditoría, sobre la base real. */
class FlakyStorage implements FileStorage {
  failPut = false;
  failRemove = false;
  failGet = false;
  breakStream = false;
  private readonly real = new LocalFileStorage(process.env.STORAGE_LOCAL_PATH!);

  async put(...args: Parameters<FileStorage['put']>) {
    if (this.failPut) throw new Error('almacenamiento caído');
    return this.real.put(...args);
  }
  async get(key: string): Promise<StoredObject> {
    if (this.failGet) throw new Error('almacenamiento caído');
    const object = await this.real.get(key);
    if (!this.breakStream) return object;
    object.stream.destroy();
    return {
      size: object.size,
      stream: Readable.from(
        (async function* () {
          yield Buffer.from('%PDF-');
          throw new Error('stream interrumpido');
        })(),
      ),
    };
  }
  stat(key: string) {
    return this.real.stat(key);
  }
  async removeAfterFailedWrite(key: string) {
    if (this.failRemove) throw new Error('no se pudo retirar');
    return this.real.removeAfterFailedWrite(key);
  }
}

class FlakyAudit extends AuditService {
  failing = new Set<string>();
  override async recordUserAction(
    ...args: Parameters<AuditService['recordUserAction']>
  ) {
    if (this.failing.has(args[1].action)) throw new Error('auditoría caída');
    return super.recordUserAction(...args);
  }
}

describe('Escenario K — ingesta bajo concurrencia real', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());
  beforeEach(() => h.drainQueue());

  const contentHeaders = (job: { id: string; claimToken: string }) => ({
    headers: { 'x-job-id': job.id, 'x-claim-token': job.claimToken },
  });
  const documentOf = async (caseId: string) =>
    (await h.sql(`SELECT * FROM documents WHERE case_id = $1`, [caseId]))[0]!;

  it.each([
    ['PDF', DOCS, pdf()],
    ['audio', VOICE, wav()],
  ])(
    'dos subidas simultáneas de %s con el mismo requestId: un caso y un trabajo',
    async (_n, route, file) => {
      const user = await h.newUser();
      const requestId = randomUUID();
      const filesBefore = storedFiles().length;
      const results = await Promise.all([
        user.a.upload(route, file, { requestId }),
        user.b.upload(route, file, { requestId }),
      ]);
      expect(statuses(results)).toEqual([200, 201]);
      expect(results[0]!.body.caseId).toBe(results[1]!.body.caseId);
      expect(results[0]!.body.documentId).toBe(results[1]!.body.documentId);
      const caseId = results[0]!.body.caseId as string;
      expect(
        await h.count(
          `SELECT count(*) AS n FROM workflow_jobs WHERE case_id = $1`,
          [caseId],
        ),
      ).toBe(1);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM documents WHERE case_id = $1`,
          [caseId],
        ),
      ).toBe(1);
      expect(
        await h.count(`SELECT count(*) AS n FROM cases WHERE owner_id = $1`, [
          user.profileId,
        ]),
      ).toBe(1);
      // El perdedor retira su copia: queda un único objeto nuevo.
      expect(storedFiles().length).toBe(filesBefore + 1);
      expect(tempFiles()).toEqual([]);
    },
  );

  it('mismo requestId con archivos diferentes: 409 y sin segundo caso', async () => {
    const user = await h.newUser();
    const requestId = randomUUID();
    const first = await user.a.upload(DOCS, pdf('A'), { requestId });
    expect(first.status).toBe(201);
    const second = await user.b.upload(DOCS, pdf('B'), { requestId });
    expect(second.status).toBe(409);
    const concurrent = await Promise.all([
      user.a.upload(DOCS, pdf('C'), { requestId: randomUUID() }),
      user.b.upload(DOCS, pdf('C'), { requestId: randomUUID() }),
    ]);
    expect(statuses(concurrent)).toEqual([201, 201]);
    expect(tempFiles()).toEqual([]);
  });

  it('dos usuarios con el mismo SHA-256: casos, objetos y accesos separados', async () => {
    const [alice, bob] = [await h.newUser(), await h.newUser()];
    const file = pdf('contenido compartido');
    const [a, b] = await Promise.all([
      alice.a.upload(DOCS, file),
      bob.b.upload(DOCS, file),
    ]);
    expect(statuses([a!, b!])).toEqual([201, 201]);
    expect(a!.body.sha256).toBe(b!.body.sha256);
    expect(a!.body.documentId).not.toBe(b!.body.documentId);
    const docs = await h.sql(
      `SELECT storage_key, owner_id FROM documents WHERE id = ANY($1::uuid[])`,
      [[a!.body.documentId, b!.body.documentId]],
    );
    expect(new Set(docs.map((d) => d.storage_key)).size).toBe(2);
    expect(
      (await bob.a.download(`/documents/${a!.body.documentId}/content`)).status,
    ).toBe(404);
    expect(
      (await alice.a.download(`/documents/${a!.body.documentId}/content`))
        .bytes,
    ).toEqual(file.bytes);
  });

  it('el límite de subidas simultáneas por usuario responde 429 sin efectos', async () => {
    const user = await h.newUser();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        user.a.upload(DOCS, pdf(`carga ${i}`)),
      ),
    );
    const accepted = results.filter((r) => r.status === 201).length;
    const limited = results.filter((r) => r.status === 429).length;
    expect(accepted + limited).toBe(6);
    expect(accepted).toBeGreaterThanOrEqual(2);
    expect(
      await h.count(`SELECT count(*) AS n FROM documents WHERE owner_id = $1`, [
        user.profileId,
      ]),
    ).toBe(accepted);
    expect(tempFiles()).toEqual([]);
    recordEvidence('upload-limit', { accepted, limited });
  });

  it('una subida cancelada por el cliente no deja temporales ni casos', async () => {
    const user = await h.newUser();
    const abort = new AbortController();
    // Cuerpo que nunca termina: el servidor recibe y el cliente corta.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '--x\r\nContent-Disposition: form-data; name="file"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n',
          ),
        );
      },
    });
    const pending = fetch(`${h.apiA.baseUrl}${DOCS}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'multipart/form-data; boundary=x',
      },
      body: stream,
      duplex: 'half',
      signal: abort.signal,
    } as RequestInit).catch((e: Error) => e.name);
    await expect.poll(() => tempFiles().length, { timeout: 5_000 }).toBe(1);
    abort.abort();
    expect(await pending).toBe('AbortError');
    await expect.poll(() => tempFiles().length, { timeout: 5_000 }).toBe(0);
    expect(
      await h.count(`SELECT count(*) AS n FROM cases WHERE owner_id = $1`, [
        user.profileId,
      ]),
    ).toBe(0);
  });

  describe('con fallos controlados', () => {
    let api: Api;
    let storage: FlakyStorage;
    let audit: FlakyAudit;
    let client: ReturnType<typeof httpClient>;
    let ownerId: string;

    beforeAll(async () => {
      storage = new FlakyStorage();
      audit = new FlakyAudit();
      api = await startApi('faults', (b) =>
        b
          .overrideProvider(FILE_STORAGE)
          .useValue(storage)
          .overrideProvider(AuditService)
          .useValue(audit),
      );
      const user = await h.newUser();
      ownerId = user.profileId;
      client = httpClient(api.baseUrl, `Bearer ${user.token}`);
    });
    afterAll(() => api.close());
    afterEach(() => {
      storage.failPut = false;
      storage.failRemove = false;
      storage.failGet = false;
      storage.breakStream = false;
      audit.failing.clear();
    });
    const failures = (action: string) =>
      h.count(
        `SELECT count(*) AS n FROM audit_events WHERE owner_id = $1 AND action = $2 AND result = 'failure'`,
        [ownerId, action],
      );
    const cases = () =>
      h.count(`SELECT count(*) AS n FROM cases WHERE owner_id = $1`, [ownerId]);

    it('fallo de auditoría tras guardar: PostgreSQL revierte y el objeto se retira', async () => {
      const before = storedFiles().length;
      const casesBefore = await cases();
      audit.failing.add('document.receive');
      const res = await client.upload(DOCS, pdf('audit'));
      expect(res.status).toBe(500);
      expect(await cases()).toBe(casesBefore);
      expect(storedFiles().length).toBe(before);
      expect(tempFiles()).toEqual([]);
    });

    it('si la compensación también falla, el huérfano queda registrado y no se oculta', async () => {
      const before = storedFiles().length;
      const casesBefore = await cases();
      const orphans = await failures('document.orphaned');
      audit.failing.add('document.receive');
      storage.failRemove = true;
      const res = await client.upload(DOCS, pdf('orphan'));
      expect(res.status).toBe(500);
      expect(await cases()).toBe(casesBefore);
      expect(storedFiles().length).toBe(before + 1);
      expect(await failures('document.orphaned')).toBe(orphans + 1);
    });

    it('fallo de almacenamiento: 503 auditado, sin caso ni temporales', async () => {
      const casesBefore = await cases();
      const before = await failures('document.store_failed');
      storage.failPut = true;
      const res = await client.upload(VOICE, wav());
      expect(res.status).toBe(503);
      expect(await cases()).toBe(casesBefore);
      expect(await failures('document.store_failed')).toBe(before + 1);
      expect(tempFiles()).toEqual([]);
    });

    it('fallo al abrir la descarga: 503 sin revelar detalles', async () => {
      const up = await client.upload(DOCS, pdf('descarga'));
      storage.failGet = true;
      const res = await client.download(
        `/documents/${up.body.documentId}/content`,
      );
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('caído');
    });

    it('cierre inesperado del stream: la conexión se corta y la API sigue viva', async () => {
      const up = await client.upload(DOCS, pdf('stream'));
      storage.breakStream = true;
      const outcome = await client
        .download(`/documents/${up.body.documentId}/content`)
        .then((r: Res) =>
          r.bytes?.length === samplePdf('stream').length
            ? 'completo'
            : 'parcial',
        )
        .catch(() => 'cortado');
      expect(outcome).not.toBe('completo');
      storage.breakStream = false;
      const again = await client.download(
        `/documents/${up.body.documentId}/content`,
      );
      expect(again.status).toBe(200);
      const health = await client.get('/health');
      expect(health.status).toBe(200);
    });
  });

  describe('acceso del worker', () => {
    const uploaded = async () => {
      const user = await h.newUser();
      const up = await user.a.upload(DOCS, pdf('worker'));
      expect(up.status).toBe(201);
      return {
        user,
        caseId: up.body.caseId as string,
        documentId: up.body.documentId as string,
      };
    };
    const content = (documentId: string) =>
      `/internal/documents/${documentId}/content`;

    it('sin reclamación: 400 sin cabeceras y 409 con un token inválido', async () => {
      const { documentId, caseId } = await uploaded();
      expect((await h.apiA.service.download(content(documentId))).status).toBe(
        400,
      );
      const [job] = await h.sql(
        `SELECT id FROM workflow_jobs WHERE case_id = $1`,
        [caseId],
      );
      const res = await h.apiA.service.download(
        content(documentId),
        contentHeaders({ id: job!.id as string, claimToken: 'x'.repeat(43) }),
      );
      expect(res.status).toBe(409);
    });

    it('reclamación vencida: 409; tras la nueva reclamación solo sirve el token vigente', async () => {
      const { caseId, documentId } = await uploaded();
      const old = await h.claimOf(caseId, 'w-old', {
        jobTypes: ['document.process'],
      });
      const ok = await h.apiA.service.download(
        content(documentId),
        contentHeaders(old),
      );
      expect(ok.status).toBe(200);
      expect(ok.bytes!.subarray(0, 5).toString()).toBe('%PDF-');
      await h.expireLease(old.id);
      expect(
        (
          await h.apiA.service.download(
            content(documentId),
            contentHeaders(old),
          )
        ).status,
      ).toBe(409);
      const current = await h.claimOf(caseId, 'w-new', {
        jobTypes: ['document.process'],
      });
      expect(
        (
          await h.apiB.service.download(
            content(documentId),
            contentHeaders(old),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await h.apiB.service.download(
            content(documentId),
            contentHeaders(current),
          )
        ).status,
      ).toBe(200);
      expect(await h.audit('document.content_access', documentId)).toBe(2);
    });

    it('un worker no descarga un documento fuera de su caso', async () => {
      const mine = await uploaded();
      const other = await uploaded();
      // El lote reclama ambos trabajos: el token del caso propio no sirve en el otro.
      const job = (await h.claimOf(mine.caseId, 'w', {
        jobTypes: ['document.process'],
      })) as ClaimedJob;
      const res = await h.apiA.service.download(
        content(other.documentId),
        contentHeaders(job),
      );
      expect(res.status).toBe(404);
      expect(await h.audit('document.content_access', other.documentId)).toBe(
        0,
      );
    });

    it('un trabajo de otro tipo no lee el documento (403)', async () => {
      const { user, caseId, documentId } = await uploaded();
      await h.drainQueue();
      await h.sql(
        `INSERT INTO workflow_jobs (case_id, job_type, idempotency_key) VALUES ($1, 'hitl.decision', $2)`,
        [caseId, randomUUID()],
      );
      const job = await h.claimOf(caseId, 'w');
      const res = await h.apiA.service.download(
        content(documentId),
        contentHeaders(job),
      );
      expect(res.status).toBe(403);
      expect(user.email).toBeDefined();
    });

    it('lecturas simultáneas con una reclamación que cambia nunca filtran el archivo al antiguo', async () => {
      const { caseId, documentId } = await uploaded();
      const old = await h.claimOf(caseId, 'w-old', {
        jobTypes: ['document.process'],
      });
      await h.expireLease(old.id);
      const current = await h.claimOf(caseId, 'w-new', {
        jobTypes: ['document.process'],
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? h.apiA : h.apiB).service.download(
            content(documentId),
            contentHeaders(i % 2 ? old : current),
          ),
        ),
      );
      results.forEach((res, i) => {
        expect(res.status).toBe(i % 2 ? 409 : 200);
      });
      await documentOf(caseId);
    });
  });
});
