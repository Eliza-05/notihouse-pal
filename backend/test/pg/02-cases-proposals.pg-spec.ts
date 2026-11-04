import { randomUUID } from 'node:crypto';
import { Harness, recordEvidence, statuses } from './support/harness.js';

describe('Casos y propuestas en PostgreSQL real', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());
  beforeEach(() => h.drainQueue());

  const caseArtifacts = async (ownerId: string, requestId: string) => {
    const key = `case-request:${ownerId}:${requestId}`;
    const jobs = await h.sql(
      `SELECT id, case_id FROM workflow_jobs WHERE idempotency_key = $1`,
      [key],
    );
    expect(jobs).toHaveLength(1);
    return {
      caseId: jobs[0]!.case_id as string,
      jobId: jobs[0]!.id as string,
    };
  };

  describe('Escenario E — idempotencia de casos', () => {
    it.each([2, 3])(
      '%i solicitudes idénticas compiten: un caso, un trabajo, un evento',
      async (n) => {
        const user = await h.newUser();
        const obligationId = await h.obligation(user);
        const requestId = randomUUID();
        // assertOwnedSubject toma FOR SHARE: la barrera las retiene DENTRO de
        // la transacción y al liberarla todas compiten por la clave única.
        const { results, blocked } = await h.behindLock(
          `case-idempotency-${n}`,
          { table: 'obligations', id: obligationId },
          n,
          () =>
            Array.from({ length: n }, (_, i) =>
              (i % 2 ? user.a : user.b).post('/cases', {
                type: 'household_obligation',
                obligationId,
                requestId,
              }),
            ),
        );
        expect(new Set(blocked.map((b) => b.pid)).size).toBe(n);
        expect(statuses(results)).toEqual([
          ...Array.from({ length: n - 1 }, () => 200),
          201,
        ]);
        expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
        const { caseId, jobId } = await caseArtifacts(
          user.profileId,
          requestId,
        );
        expect(results[0]!.body.id).toBe(caseId);
        expect(await h.audit('case.create', caseId)).toBe(1);
        expect(await h.audit('workflow_job.create', jobId)).toBe(1);
      },
    );

    it('misma clave con datos distintos: 409, incluso compitiendo', async () => {
      const user = await h.newUser();
      const [o1, o2] = [await h.obligation(user), await h.obligation(user)];
      const requestId = randomUUID();
      const { results } = await h.behindLock(
        'case-idempotency-different-data',
        { table: 'obligations', id: o1 },
        1,
        () => [
          user.a.post('/cases', {
            type: 'household_obligation',
            obligationId: o1,
            requestId,
          }),
        ],
      );
      expect(results[0]!.status).toBe(201);
      const conflict = await user.b.post('/cases', {
        type: 'household_obligation',
        obligationId: o2,
        requestId,
      });
      expect(conflict.status).toBe(409);
      const { caseId } = await caseArtifacts(user.profileId, requestId);
      expect(results[0]!.body.id).toBe(caseId);
      const [row] = await h.sql(
        `SELECT obligation_id FROM cases WHERE id = $1`,
        [caseId],
      );
      expect(row!.obligation_id).toBe(o1);
    });

    it('la misma clave de dos propietarios crea dos casos independientes', async () => {
      const [alice, bob] = [await h.newUser(), await h.newUser()];
      const requestId = randomUUID();
      const body = { type: 'household_obligation', requestId };
      const results = await Promise.all([
        alice.a.post('/cases', body),
        bob.b.post('/cases', body),
      ]);
      expect(statuses(results)).toEqual([201, 201]);
      expect(results[0]!.body.id).not.toBe(results[1]!.body.id);
      await caseArtifacts(alice.profileId, requestId);
      await caseArtifacts(bob.profileId, requestId);
    });

    it('reintento tras timeout del cliente devuelve el caso ya creado', async () => {
      const user = await h.newUser();
      const obligationId = await h.obligation(user);
      const requestId = randomUUID();
      const body = {
        type: 'household_obligation',
        obligationId,
        requestId,
      };
      const abort = new AbortController();
      const control = await h.owner.connect();
      await control.query('BEGIN');
      await control.query(
        `SELECT 1 FROM obligations WHERE id = $1 FOR UPDATE`,
        [obligationId],
      );
      const timedOut = user.a
        .post('/cases', body, { signal: abort.signal })
        .catch((e: Error) => e.name);
      await h.waitBlocked(1);
      abort.abort();
      expect(await timedOut).toBe('AbortError');
      await control.query('ROLLBACK');
      control.release();
      // El servidor sigue su transacción; el reintento converge en un caso.
      const retry = await user.b.post('/cases', body);
      expect([200, 201]).toContain(retry.status);
      await expect
        .poll(() =>
          caseArtifacts(user.profileId, requestId).then((a) => a.caseId),
        )
        .toBe(retry.body.id);
      expect(await h.audit('case.create', retry.body.id as string)).toBe(1);
    });
  });

  describe('Escenario F — versionado y deduplicación de propuestas', () => {
    const versions = (caseId: string) =>
      h.sql<{ version: number; review_status: string }>(
        `SELECT version, review_status FROM case_proposals WHERE case_id = $1 ORDER BY version`,
        [caseId],
      );

    it('una versión anterior no revive y el reenvío no reemplaza a la vigente', async () => {
      const user = await h.newUser();
      const { c, job } = await h.claimedCase(user);
      const v1 = await h.propose(c.id, job, { amount: '100.00' });
      const review = await h.review(c.id, job, v1.body.id as string);
      const v2 = await h.propose(c.id, job, { amount: '200.00' });
      expect([v1.status, v2.status]).toEqual([201, 201]);
      expect(v2.body.version).toBe(2);

      const lateV1 = await h.propose(c.id, job, { amount: '100.00' });
      expect(lateV1.status).toBe(200);
      expect(lateV1.body).toMatchObject({
        id: v1.body.id,
        version: 1,
        reviewStatus: 'superseded',
      });
      const resendV2 = await h.propose(c.id, job, { amount: '200.00' });
      expect(resendV2.status).toBe(200);
      expect(resendV2.body.id).toBe(v2.body.id);

      expect(await versions(c.id)).toEqual([
        { version: 1, review_status: 'superseded' },
        { version: 2, review_status: 'pending_review' },
      ]);
      // Ni la revisión anulada ni la propuesta reemplazada vuelven a la vida.
      const [hitl] = await h.sql(
        `SELECT status FROM hitl_requests WHERE id = $1`,
        [review.body.id],
      );
      expect(hitl!.status).toBe('cancelled');
      const revive = await h.review(c.id, job, v1.body.id as string, 'otra');
      expect(revive.status).toBe(409);
      const decision = await user.a.post(
        `/hitl-requests/${review.body.id}/decision`,
        { decision: 'approved' },
      );
      expect(decision.status).toBe(409);
      const apply = await user.a.post(
        `/cases/${c.id}/proposals/${v1.body.id}/apply`,
      );
      expect(apply.status).toBe(409);
      // Secuencia auditada: creación v1, creación v2, reemplazo de v1.
      const events = await h.sql(
        `SELECT action FROM audit_events WHERE correlation_id = $1
           AND action LIKE 'case_proposal.%' AND result = 'success' ORDER BY occurred_at, id`,
        [c.correlationId],
      );
      expect(events.map((e) => e.action).sort()).toEqual([
        'case_proposal.create',
        'case_proposal.create',
        'case_proposal.supersede',
      ]);
    });

    it('la misma propuesta enviada a la vez crea una sola versión', async () => {
      const user = await h.newUser();
      const { c, job } = await h.claimedCase(user);
      const { results, blocked } = await h.behindLock(
        'proposal-same-content',
        { table: 'workflow_jobs', id: job.id },
        4,
        () =>
          Array.from({ length: 4 }, () => h.propose(c.id, job, { b: 2, a: 1 })),
      );
      expect(new Set(blocked.map((b) => b.pid)).size).toBe(4);
      expect(statuses(results)).toEqual([200, 200, 200, 201]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await versions(c.id)).toEqual([
        { version: 1, review_status: 'pending_review' },
      ]);
    });

    it('propuestas distintas a la vez: versiones consecutivas y una vigente', async () => {
      const user = await h.newUser();
      const { c, job } = await h.claimedCase(user);
      const { results } = await h.behindLock(
        'proposal-different-content',
        { table: 'cases', id: c.id },
        5,
        () =>
          Array.from({ length: 5 }, (_, i) =>
            h.propose(c.id, job, { amount: `${i + 1}.00` }),
          ),
      );
      expect(statuses(results)).toEqual([201, 201, 201, 201, 201]);
      const rows = await versions(c.id);
      expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
      expect(rows.filter((r) => r.review_status === 'pending_review')).toEqual([
        { version: 5, review_status: 'pending_review' },
      ]);
      const superseded = await h.count(
        `SELECT count(*) AS n FROM audit_events WHERE correlation_id = $1 AND action = 'case_proposal.supersede'`,
        [c.correlationId],
      );
      expect(superseded).toBe(4);
      recordEvidence('proposal-versions', { versions: rows.length });
    });

    it('un worker antiguo no escribe propuestas, ni compitiendo con el vigente', async () => {
      const user = await h.newUser();
      const { c, job: old } = await h.claimedCase(user);
      await h.expireLease(old.id);
      const current = await h.claimOf(c.id, 'worker-new');
      const { results } = await h.behindLock(
        'proposal-stale-worker',
        { table: 'workflow_jobs', id: old.id },
        2,
        () => [
          h.propose(c.id, old, { amount: 'antiguo' }),
          h.propose(c.id, current, { amount: 'vigente' }),
        ],
      );
      expect(results[0]!.status).toBe(409);
      expect(results[1]!.status).toBe(201);
      const stored = await h.sql(
        `SELECT proposed_data FROM case_proposals WHERE case_id = $1`,
        [c.id],
      );
      expect(stored).toEqual([{ proposed_data: { amount: 'vigente' } }]);
    });
  });
});
