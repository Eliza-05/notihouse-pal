import {
  type ClaimedJob,
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';

/**
 * Regresiones de la auditoría de la Fase 4.2F.1 sobre la cola, las propuestas
 * y la integridad (PGlite: una sola conexión; no prueba contención real entre
 * conexiones remotas).
 */
describe('Backend hardening (e2e)', () => {
  let w: ProcessWorld;
  const { sql, drainQueue, newCase, claim, expireLease } = processHelpers(
    () => w,
  );
  const svc = () => w.h.asService();
  const ref = (job: ClaimedJob) => ({
    jobId: job.id,
    claimToken: job.claimToken,
  });

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);

  afterAll(async () => {
    await w.h.app.close();
  });

  const startCase = async () => {
    await drainQueue();
    const c = await newCase(w.laura);
    const [job] = await claim('worker-1');
    return { c, job: job! };
  };

  const propose = (caseId: string, job: ClaimedJob, proposedData: object) =>
    svc().post(`/internal/cases/${caseId}/proposals`, {
      ...ref(job),
      source: 'llm',
      proposedData,
    });

  describe('late AI responses', () => {
    it('a delayed retransmission of an earlier version does not revive it', async () => {
      const { c, job } = await startCase();
      const first = (await propose(c.id, job, { amount: '100.00' }).expect(201))
        .body;
      const second = (
        await propose(c.id, job, { amount: '200.00' }).expect(201)
      ).body;
      // Reintento tardío de la primera solicitud (misma reclamación vigente).
      const late = await propose(c.id, job, { amount: '100.00' });
      expect(late.status).toBe(200);
      expect(late.body).toMatchObject({
        id: first.id,
        version: 1,
        reviewStatus: 'superseded',
      });
      const versions = await sql<{ version: number; review_status: string }>(
        `SELECT version, review_status FROM case_proposals WHERE case_id = $1 ORDER BY version`,
        [c.id],
      );
      expect(versions).toEqual([
        { version: 1, review_status: 'superseded' },
        { version: 2, review_status: 'pending_review' },
      ]);
      expect(second.reviewStatus).toBe('pending_review');
    });

    it('a stale worker cannot write after its lease was re-claimed', async () => {
      const { c, job } = await startCase();
      await expireLease(job.id);
      const [again] = await claim('worker-2');
      expect(again!.id).toBe(job.id);
      await propose(c.id, job, { amount: '1.00' }).expect(409);
      await svc()
        .post(`/internal/workflow-jobs/${job.id}/complete`, {
          claimToken: job.claimToken,
        })
        .expect(409);
      await propose(c.id, again!, { amount: '1.00' }).expect(201);
    });
  });

  describe('job completion', () => {
    it('a repeated complete never runs twice and keeps the first result', async () => {
      const { job } = await startCase();
      await svc()
        .post(`/internal/workflow-jobs/${job.id}/complete`, {
          claimToken: job.claimToken,
          result: { pages: 1 },
        })
        .expect(200);
      // Contrato vigente: un `complete` repetido de la misma reclamación es
      // idempotente aunque traiga otro `result`; se conserva el primero.
      const repeated = await svc()
        .post(`/internal/workflow-jobs/${job.id}/complete`, {
          claimToken: job.claimToken,
          result: { pages: 99 },
        })
        .expect(200);
      expect(repeated.body.result).toEqual({ pages: 1 });
      const [counts] = await sql<{ n: string }>(
        `SELECT count(*) AS n FROM audit_events WHERE action = 'workflow_job.complete' AND metadata->>'resourceId' = $1`,
        [job.id],
      );
      expect(Number(counts!.n)).toBe(1);
    });
  });
});
