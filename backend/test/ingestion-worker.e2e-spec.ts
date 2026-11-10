import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { AuditService } from '../src/audit/audit.service.js';
import { WorkflowJobsService } from '../src/integrations/workflow-jobs.service.js';
import {
  FILE_STORAGE,
  StorageUnavailableError,
} from '../src/storage/file-storage.js';
import { LocalFileStorage } from '../src/storage/local-file-storage.js';
import type { TestUser } from './support/pglite.js';
import {
  type ClaimedJob,
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import { samplePdf, sampleWav } from './support/sample-files.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Acceso del worker a archivos (solo con reclamación vigente de un trabajo
 * autorizado del mismo caso) y tratamiento
 * de fallos del almacenamiento y de PostgreSQL con compensación.
 */
describe('Worker file access and failures (e2e)', () => {
  let w: ProcessWorld;
  const { sql, drainQueue, claim, expireLease } = processHelpers(() => w);
  const STORAGE = process.env.STORAGE_LOCAL_PATH!;

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

  const uploadWith = (
    app: TestApp,
    user: TestUser,
    route: 'documents' | 'voice',
    fields: Record<string, string> = {},
  ) => {
    let req = request(app.app.getHttpServer())
      .post(`/api/v1/ingestions/${route}`)
      .set('Authorization', `Bearer ${app.tokenFor(user)}`);
    for (const [key, value] of Object.entries(fields))
      req = req.field(key, value);
    return route === 'documents'
      ? req.attach('file', samplePdf(`Factura ${randomUUID()}`), {
          filename: 'factura.pdf',
          contentType: 'application/pdf',
        })
      : req.attach('file', sampleWav(), {
          filename: 'nota.wav',
          contentType: 'audio/wav',
        });
  };

  /** Ingesta + reclamación de su trabajo por el worker. */
  const ingestAndClaim = async (
    user: TestUser,
    route: 'documents' | 'voice',
  ) => {
    await drainQueue();
    const up = (await uploadWith(w.h, user, route).expect(201)).body as {
      documentId: string;
      caseId: string;
      correlationId: string;
    };
    const [job] = await claim('worker-1');
    expect(job!.case.id).toBe(up.caseId);
    return { up, job: job! };
  };

  const readAsWorker = (
    documentId: string,
    job?: Partial<ClaimedJob>,
    auth?: string,
  ) => {
    let req = request(w.h.app.getHttpServer()).get(
      `/api/v1/internal/documents/${documentId}/content`,
    );
    req = req.set(
      'Authorization',
      auth ?? `Bearer ${process.env.N8N_SERVICE_TOKEN}`,
    );
    if (job?.id) req = req.set('X-Job-Id', job.id);
    if (job?.claimToken) req = req.set('X-Claim-Token', job.claimToken);
    return req;
  };

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);

  afterAll(async () => {
    await w.h.app.close();
    await w.t.client.close();
  });

  describe('worker access to files', () => {
    it('streams the file of the claimed case and audits the access', async () => {
      const { up, job } = await ingestAndClaim(w.laura, 'documents');
      const res = await readAsWorker(up.documentId, job).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/^attachment/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const [event] = await sql<Record<string, unknown>>(
        `SELECT actor_type, actor_id, correlation_id FROM audit_events WHERE action = 'document.content_access' AND metadata->>'resourceId' = $1`,
        [up.documentId],
      );
      expect(event).toEqual({
        actor_type: 'workflow',
        actor_id: 'n8n:worker-1',
        correlation_id: up.correlationId,
      });
    });

    it('lets the transcription job read the voice note', async () => {
      const { up, job } = await ingestAndClaim(w.andres, 'voice');
      expect(job.jobType).toBe('voice.transcribe');
      const res = await readAsWorker(up.documentId, job).expect(200);
      expect(res.headers['content-type']).toBe('audio/wav');
    });

    it('rejects missing, wrong or user credentials', async () => {
      const { up, job } = await ingestAndClaim(w.laura, 'documents');
      await readAsWorker(up.documentId, job, '').expect(401);
      await readAsWorker(up.documentId, job, 'Bearer wrong').expect(401);
      await readAsWorker(
        up.documentId,
        job,
        `Bearer ${w.h.tokenFor(w.laura)}`,
      ).expect(401);
      // El token de servicio solo, sin reclamación, no basta.
      await readAsWorker(up.documentId).expect(400);
      await readAsWorker(up.documentId, { id: job.id }).expect(400);
    });

    it('rejects a wrong claim token and an expired lease', async () => {
      const { up, job } = await ingestAndClaim(w.laura, 'documents');
      await readAsWorker(up.documentId, {
        id: job.id,
        claimToken: 'D'.repeat(43),
      }).expect(409);
      await expireLease(job.id);
      await readAsWorker(up.documentId, job).expect(409);
    });

    it('rejects a document of another case or another owner', async () => {
      const mine = await ingestAndClaim(w.laura, 'documents');
      const other = (await uploadWith(w.h, w.andres, 'documents').expect(201))
        .body;
      await readAsWorker(other.documentId, mine.job).expect(404);
      const laurasOther = (
        await uploadWith(w.h, w.laura, 'documents').expect(201)
      ).body;
      await readAsWorker(laurasOther.documentId, mine.job).expect(404);
      await readAsWorker(randomUUID(), mine.job).expect(404);
    });

    it('rejects a job type not authorized for the document type (403)', async () => {
      const { up, job } = await ingestAndClaim(w.andres, 'voice');
      await sql(
        `UPDATE workflow_jobs SET job_type = 'document.process' WHERE id = $1`,
        [job.id],
      );
      await readAsWorker(up.documentId, job).expect(403);
      await sql(
        `UPDATE workflow_jobs SET job_type = 'hitl.decision' WHERE id = $1`,
        [job.id],
      );
      await readAsWorker(up.documentId, job).expect(403);
    });

    it('reading the file never changes business or process state', async () => {
      const { up, job } = await ingestAndClaim(w.andres, 'documents');
      const before = await sql(
        `SELECT (SELECT status FROM cases WHERE id = $1) AS c,
                (SELECT status FROM workflow_jobs WHERE id = $2) AS j,
                (SELECT status FROM rent_charges WHERE id = $3) AS r`,
        [up.caseId, job.id, w.andresCharge],
      );
      await readAsWorker(up.documentId, job).expect(200);
      expect(
        await sql(
          `SELECT (SELECT status FROM cases WHERE id = $1) AS c,
                  (SELECT status FROM workflow_jobs WHERE id = $2) AS j,
                  (SELECT status FROM rent_charges WHERE id = $3) AS r`,
          [up.caseId, job.id, w.andresCharge],
        ),
      ).toEqual(before);
    });
  });

  describe('failures and compensation', () => {
    it('does not create anything when the storage is unavailable (503) and records the failure', async () => {
      const failing = await createTestApp(w.t.db, (b) =>
        b.overrideProvider(FILE_STORAGE).useValue({
          put: () => Promise.reject(new StorageUnavailableError()),
          get: () => Promise.reject(new StorageUnavailableError()),
          stat: () => Promise.resolve(null),
          removeAfterFailedWrite: () => Promise.resolve(),
        }),
      );
      try {
        const before = await counts();
        const res = await uploadWith(failing, w.laura, 'documents').expect(503);
        expect(JSON.stringify(res.body)).not.toMatch(
          /storage\/|\.local|[A-Z]:\\/,
        );
        expect(await counts()).toEqual(before);
        const events = await sql<{ result: string }>(
          `SELECT result FROM audit_events WHERE action = 'document.store_failed' AND owner_id = $1`,
          [w.laura.profileId],
        );
        expect(events.map((e) => e.result)).toContain('failure');
      } finally {
        await failing.app.close();
      }
    });

    it('removes the stored object when the PostgreSQL transaction fails', async () => {
      const reject = () =>
        Promise.reject(new Error('audit storage unavailable'));
      const failing = await createTestApp(w.t.db, (b) =>
        b.overrideProvider(AuditService).useValue({
          recordUserAction: reject,
          recordAutomatedAction: reject,
        }),
      );
      try {
        const before = {
          files: await filesUnder(STORAGE),
          rows: await counts(),
        };
        await uploadWith(failing, w.laura, 'documents', {
          requestId: randomUUID(),
        }).expect(500);
        await uploadWith(failing, w.andres, 'voice').expect(500);
        expect(await filesUnder(STORAGE)).toEqual(before.files);
        expect(await counts()).toEqual(before.rows);
      } finally {
        await failing.app.close();
      }
    });

    it('records an orphan when compensation itself fails', async () => {
      const real = new LocalFileStorage(STORAGE);
      const failing = await createTestApp(w.t.db, (b) =>
        b
          .overrideProvider(FILE_STORAGE)
          .useValue({
            put: real.put.bind(real),
            get: real.get.bind(real),
            stat: real.stat.bind(real),
            removeAfterFailedWrite: () =>
              Promise.reject(new StorageUnavailableError()),
          })
          .overrideProvider(WorkflowJobsService)
          .useValue({ enqueue: () => Promise.reject(new Error('queue down')) }),
      );
      try {
        const before = await counts();
        await uploadWith(failing, w.camila, 'documents').expect(500);
        expect(await counts()).toEqual(before);
        const [orphan] = await sql<{ result: string; resource_id: string }>(
          `SELECT result, metadata->>'resourceId' AS resource_id FROM audit_events
            WHERE action = 'document.orphaned' AND owner_id = $1`,
          [w.camila.profileId],
        );
        expect(orphan!.result).toBe('failure');
        expect(orphan!.resource_id).toMatch(
          /^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/,
        );
        // El objeto huérfano existe y es identificable para su limpieza.
        expect(await real.stat(orphan!.resource_id)).not.toBeNull();
      } finally {
        await failing.app.close();
      }
    });
  });
});
