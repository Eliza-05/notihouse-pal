import { Harness, type User, statuses } from './support/harness.js';

describe('HITL y aplicación de propuestas en PostgreSQL real', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());
  beforeEach(() => h.drainQueue());

  const decide = (user: User, id: string, decision: string, api: 'a' | 'b') =>
    user[api].post(`/hitl-requests/${id}/decision`, { decision });
  const hitl = async (id: string) =>
    (await h.sql(`SELECT * FROM hitl_requests WHERE id = $1`, [id]))[0]!;
  const decisions = async (id: string) =>
    (await h.audit('hitl_request.approve', id)) +
    (await h.audit('hitl_request.reject', id));
  const decisionJobs = (id: string) =>
    h.count(
      `SELECT count(*) AS n FROM workflow_jobs WHERE idempotency_key = $1`,
      [`hitl-decision:${id}`],
    );

  describe('Escenario G — HITL bajo concurrencia real', () => {
    it('aprobar y rechazar a la vez: una decisión prevalece y la otra recibe 409', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 4; i++) {
        const user = await h.newUser();
        const r = await h.pendingReview(user);
        const { results, blocked } = await h.behindLock(
          'hitl-approve-vs-reject',
          { table: 'cases', id: r.caseId },
          2,
          () =>
            i % 2
              ? [
                  decide(user, r.reviewId, 'approved', 'a'),
                  decide(user, r.reviewId, 'rejected', 'b'),
                ]
              : [
                  decide(user, r.reviewId, 'rejected', 'b'),
                  decide(user, r.reviewId, 'approved', 'a'),
                ],
        );
        expect(new Set(blocked.map((b) => b.pid)).size).toBe(2);
        expect(statuses(results)).toEqual([200, 409]);
        const row = await hitl(r.reviewId);
        const [proposal] = await h.sql(
          `SELECT review_status FROM case_proposals WHERE id = $1`,
          [r.proposalId],
        );
        seen.add(row.status as string);
        expect((row.decision as { outcome: string }).outcome).toBe(row.status);
        expect(proposal!.review_status).toBe(
          row.status === 'approved' ? 'accepted' : 'rejected',
        );
        expect(await decisions(r.reviewId)).toBe(1);
        expect(await decisionJobs(r.reviewId)).toBe(1);
        await h.drainQueue();
      }
      expect(seen.size).toBeGreaterThan(0);
    });

    it.each(['approved', 'rejected'])(
      'decisiones duplicadas idénticas (%s): 200 y una sola transición',
      async (decision) => {
        const user = await h.newUser();
        const r = await h.pendingReview(user);
        const { results } = await h.behindLock(
          'hitl-duplicate',
          { table: 'cases', id: r.caseId },
          3,
          () =>
            (['a', 'b', 'a'] as const).map((api) =>
              decide(user, r.reviewId, decision, api),
            ),
        );
        expect(statuses(results)).toEqual([200, 200, 200]);
        expect(await decisions(r.reviewId)).toBe(1);
        expect(await decisionJobs(r.reviewId)).toBe(1);
      },
    );

    it('vencida: 409, se materializa `expired`, cierra el caso y no aprueba', async () => {
      const user = await h.newUser();
      const r = await h.pendingReview(user);
      await h.sql(
        `UPDATE hitl_requests SET created_at = now() - interval '25 hours', due_at = now() - interval '1 hour' WHERE id = $1`,
        [r.reviewId],
      );
      const res = await decide(user, r.reviewId, 'approved', 'a');
      expect(res.status).toBe(409);
      const row = await hitl(r.reviewId);
      expect(row.status).toBe('expired');
      expect(row.decision).toBeNull();
      expect(await decisions(r.reviewId)).toBe(0);
      expect(await decisionJobs(r.reviewId)).toBe(0);
      const [c] = await h.sql(`SELECT status FROM cases WHERE id = $1`, [
        r.caseId,
      ]);
      expect(c!.status).toBe('failed');
      const apply = await user.a.post(
        `/cases/${r.caseId}/proposals/${r.proposalId}/apply`,
      );
      expect(apply.status).toBe(409);
    });

    it('la fecha límite exacta ya no admite decisión; un instante antes sí', async () => {
      const user = await h.newUser();
      const atLimit = await h.pendingReview(user);
      await h.sql(
        `UPDATE hitl_requests SET created_at = now() - interval '24 hours', due_at = now() WHERE id = $1`,
        [atLimit.reviewId],
      );
      expect(
        (await decide(user, atLimit.reviewId, 'approved', 'a')).status,
      ).toBe(409);
      expect((await hitl(atLimit.reviewId)).status).toBe('expired');

      const justBefore = await h.pendingReview(user, '2099-03-15');
      await h.sql(
        `UPDATE hitl_requests SET due_at = now() + interval '20 seconds' WHERE id = $1`,
        [justBefore.reviewId],
      );
      const ok = await decide(user, justBefore.reviewId, 'approved', 'a');
      expect(ok.status).toBe(200);
      const row = await hitl(justBefore.reviewId);
      expect(new Date(row.responded_at).getTime()).toBeLessThan(
        new Date(row.due_at).getTime(),
      );
    });

    it('una decisión retenida en un bloqueo más allá del plazo no aprueba', async () => {
      const user = await h.newUser();
      const r = await h.pendingReview(user);
      await h.sql(
        `UPDATE hitl_requests SET due_at = now() + interval '1 second' WHERE id = $1`,
        [r.reviewId],
      );
      const control = await h.owner.connect();
      await control.query('BEGIN');
      await control.query(`SELECT 1 FROM cases WHERE id = $1 FOR UPDATE`, [
        r.caseId,
      ]);
      const pending = decide(user, r.reviewId, 'approved', 'a');
      await h.waitBlocked(1);
      // El plazo vence mientras la solicitud espera el bloqueo del caso.
      await expect
        .poll(
          () =>
            h.count(
              `SELECT count(*) AS n FROM hitl_requests WHERE id = $1 AND due_at <= clock_timestamp()`,
              [r.reviewId],
            ),
          { timeout: 5_000, interval: 50 },
        )
        .toBe(1);
      await control.query('ROLLBACK');
      control.release();
      const res = await pending;
      expect(res.status).toBe(409);
      const row = await hitl(r.reviewId);
      expect(row.status).toBe('expired');
      const [proposal] = await h.sql(
        `SELECT review_status FROM case_proposals WHERE id = $1`,
        [r.proposalId],
      );
      expect(proposal!.review_status).toBe('pending_review');
    });

    it('vencimiento simultáneo con aprobación: nunca queda aprobada', async () => {
      const user = await h.newUser();
      const r = await h.pendingReview(user);
      await h.sql(
        `UPDATE hitl_requests SET created_at = now() - interval '25 hours', due_at = now() - interval '1 second' WHERE id = $1`,
        [r.reviewId],
      );
      const { results } = await h.behindLock(
        'hitl-expire-vs-approve',
        { table: 'cases', id: r.caseId },
        3,
        () => [
          decide(user, r.reviewId, 'approved', 'a'),
          h.apiB.service.post('/internal/hitl-requests/expire', {
            workerId: 'scheduler',
            limit: 50,
          }),
          decide(user, r.reviewId, 'approved', 'b'),
        ],
      );
      expect(results[0]!.status).toBe(409);
      expect(results[2]!.status).toBe(409);
      expect(results[1]!.status).toBe(200);
      const row = await hitl(r.reviewId);
      expect(row.status).toBe('expired');
      expect(await h.audit('hitl_request.expire', r.reviewId)).toBe(1);
      expect(await decisions(r.reviewId)).toBe(0);
    });

    it('una aprobación en plazo compitiendo con el barrido se conserva', async () => {
      const user = await h.newUser();
      const r = await h.pendingReview(user);
      const { results } = await h.behindLock(
        'hitl-valid-approve-vs-sweep',
        { table: 'cases', id: r.caseId },
        1,
        () => [
          decide(user, r.reviewId, 'approved', 'a'),
          h.apiB.service.post('/internal/hitl-requests/expire', {
            workerId: 'scheduler',
            limit: 50,
          }),
        ],
      );
      expect(results[0]!.status).toBe(200);
      expect((results[1]!.body.expired as string[]) ?? []).not.toContain(
        r.reviewId,
      );
      expect((await hitl(r.reviewId)).status).toBe('approved');
    });

    it('propuesta reemplazada mientras se revisa: la decisión llega tarde', async () => {
      const user = await h.newUser();
      const r = await h.pendingReview(user);
      const { results } = await h.behindLock(
        'hitl-replace-vs-approve',
        { table: 'cases', id: r.caseId },
        2,
        () => [
          h.propose(r.caseId, r.job, { amount: 'nueva versión' }),
          decide(user, r.reviewId, 'approved', 'a'),
        ],
      );
      const [replace, decision] = results;
      // Cualquier orden es válido; lo inválido es aprobar lo ya reemplazado.
      const [proposal] = await h.sql(
        `SELECT review_status FROM case_proposals WHERE id = $1`,
        [r.proposalId],
      );
      const row = await hitl(r.reviewId);
      expect(replace!.status).toBe(201);
      if (decision!.status === 200) {
        expect(row.status).toBe('approved');
        expect(proposal!.review_status).toBe('accepted');
        const apply = await user.a.post(
          `/cases/${r.caseId}/proposals/${r.proposalId}/apply`,
        );
        expect(apply.status).toBe(409);
      } else {
        expect(decision!.status).toBe(409);
        expect(row.status).toBe('cancelled');
        expect(proposal!.review_status).toBe('superseded');
      }
    });

    it('caso cerrado con HITL pendiente: se anula y no admite decisión', async () => {
      const user = await h.newUser();
      const r = await h.pendingReview(user);
      const failCase = await h.apiA.service.post(
        `/internal/cases/${r.caseId}/fail`,
        { jobId: r.job.id, claimToken: r.job.claimToken, reason: 'cierre' },
      );
      expect(failCase.status).toBe(200);
      expect((await hitl(r.reviewId)).status).toBe('cancelled');
      expect((await decide(user, r.reviewId, 'approved', 'a')).status).toBe(
        409,
      );
    });

    it('el worker no puede continuar sin una aprobación válida', async () => {
      const user = await h.newUser();
      const r = await h.pendingReview(user);
      const close = await h.apiA.service.post(
        `/internal/cases/${r.caseId}/complete`,
        { jobId: r.job.id, claimToken: r.job.claimToken },
      );
      expect(close.status).toBe(409);
      // El servicio no tiene ruta para decidir; un token de servicio tampoco
      // sirve en la ruta humana.
      const asService = await h.apiA.service.post(
        `/hitl-requests/${r.reviewId}/decision`,
        { decision: 'approved' },
      );
      expect(asService.status).toBe(401);
      const apply = await user.a.post(
        `/cases/${r.caseId}/proposals/${r.proposalId}/apply`,
      );
      expect(apply.status).toBe(409);
      expect((await hitl(r.reviewId)).status).toBe('pending');
    });
  });

  describe('Escenario H — aplicación exactamente una vez', () => {
    const applyPath = (r: { caseId: string; proposalId: string }) =>
      `/cases/${r.caseId}/proposals/${r.proposalId}/apply`;
    const artifacts = async (r: {
      proposalId: string;
      obligationId: string;
    }) => ({
      applications: await h.count(
        `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
        [r.proposalId],
      ),
      occurrences: await h.count(
        `SELECT count(*) AS n FROM obligation_occurrences WHERE obligation_id = $1`,
        [r.obligationId],
      ),
      applied: await h.count(
        `SELECT count(*) AS n FROM audit_events WHERE action = 'case_proposal.apply' AND result = 'success' AND metadata->>'resourceId' = $1`,
        [r.proposalId],
      ),
    });

    it.each([2, 3, 8])(
      '%i aplicaciones compiten: un período, una aplicación, un evento',
      async (n) => {
        const user = await h.newUser();
        const r = await h.approvedProposal(user);
        const { results, blocked } = await h.behindLock(
          `apply-race-${n}`,
          { table: 'cases', id: r.caseId },
          n,
          () =>
            Array.from({ length: n }, (_, i) =>
              (i % 2 ? user.a : user.b).post(applyPath(r)),
            ),
        );
        expect(new Set(blocked.map((b) => b.pid)).size).toBe(n);
        expect(statuses(results)).toEqual([
          ...Array.from({ length: n - 1 }, () => 200),
          201,
        ]);
        expect(await artifacts(r)).toEqual({
          applications: 1,
          occurrences: 1,
          applied: 1,
        });
        const [occurrence] = await h.sql(
          `SELECT status, confirmed_at, confirmed_by FROM obligation_occurrences WHERE obligation_id = $1`,
          [r.obligationId],
        );
        expect(occurrence).toEqual({
          status: 'pending',
          confirmed_at: null,
          confirmed_by: null,
        });
      },
    );

    it('repetir tras el éxito devuelve la aplicación sin escribir', async () => {
      const user = await h.newUser();
      const r = await h.approvedProposal(user);
      const first = await user.a.post(applyPath(r));
      expect(first.status).toBe(201);
      const again = await user.b.post(applyPath(r));
      expect(again.status).toBe(200);
      expect(again.body.alreadyApplied).toBe(true);
      expect(again.body.resource.id).toBe(first.body.resource.id);
      expect(await artifacts(r)).toEqual({
        applications: 1,
        occurrences: 1,
        applied: 1,
      });
    });

    it('sin HITL válida no se aplica', async () => {
      const user = await h.newUser();
      const pending = await h.pendingReview(user);
      expect((await user.a.post(applyPath(pending))).status).toBe(409);
      expect(await artifacts(pending)).toEqual({
        applications: 0,
        occurrences: 0,
        applied: 0,
      });
      await h.drainQueue();
      const rejected = await h.pendingReview(user);
      await decide(user, rejected.reviewId, 'rejected', 'a');
      expect((await user.a.post(applyPath(rejected))).status).toBe(409);
      expect((await artifacts(rejected)).occurrences).toBe(0);
    });

    it('una propuesta aceptada pero luego reemplazada no se aplica', async () => {
      const user = await h.newUser();
      const r = await h.approvedProposal(user);
      const newer = await h.propose(r.caseId, r.job, { amount: 'v2' });
      expect(newer.status).toBe(201);
      expect((await user.a.post(applyPath(r))).status).toBe(409);
      expect((await artifacts(r)).occurrences).toBe(0);
    });

    it('un período ya existente se conserva y la aplicación responde 409', async () => {
      const user = await h.newUser();
      const r = await h.approvedProposal(user);
      const manual = await h.occurrence(
        user,
        r.obligationId,
        r.dueDate,
        `${r.dueDate.slice(0, 8)}01`,
      );
      const res = await user.a.post(applyPath(r));
      expect(res.status).toBe(409);
      const rows = await h.sql(
        `SELECT id FROM obligation_occurrences WHERE obligation_id = $1`,
        [r.obligationId],
      );
      expect(rows).toEqual([{ id: manual }]);
    });

    it('compitiendo con un alta manual del mismo período queda uno solo', async () => {
      const user = await h.newUser();
      const r = await h.approvedProposal(user);
      const { results } = await h.behindLock(
        'apply-vs-manual-occurrence',
        { table: 'obligations', id: r.obligationId },
        2,
        () => [
          user.a.post(applyPath(r)),
          user.b.post(`/obligations/${r.obligationId}/occurrences`, {
            periodStart: `${r.dueDate.slice(0, 8)}01`,
            periodEnd: `${r.dueDate.slice(0, 8)}28`,
            dueDate: r.dueDate,
          }),
        ],
      );
      expect(statuses(results).filter((s) => s === 201)).toHaveLength(1);
      expect(statuses(results).filter((s) => s === 409)).toHaveLength(1);
      const state = await artifacts(r);
      expect(state.occurrences).toBe(1);
      expect(state.applications).toBe(results[0]!.status === 201 ? 1 : 0);
    });

    it('una propuesta o una obligación de otro propietario no se aplica', async () => {
      const [alice, bob] = [await h.newUser(), await h.newUser()];
      const r = await h.approvedProposal(alice);
      expect((await bob.a.post(applyPath(r))).status).toBe(404);
      expect((await artifacts(r)).applications).toBe(0);

      const foreignObligation = await h.obligation(bob);
      const c = await h.claimedCase(alice);
      const proposal = await h.propose(c.c.id, c.job, {
        action: 'create_obligation_occurrence',
        data: {
          obligationId: foreignObligation,
          periodStart: '2099-04-01',
          periodEnd: '2099-04-30',
          dueDate: '2099-04-15',
        },
      });
      const review = await h.review(c.c.id, c.job, proposal.body.id as string);
      await decide(alice, review.body.id as string, 'approved', 'a');
      const res = await alice.a.post(
        `/cases/${c.c.id}/proposals/${proposal.body.id}/apply`,
      );
      expect(res.status).toBe(404);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM obligation_occurrences WHERE obligation_id = $1`,
          [foreignObligation],
        ),
      ).toBe(0);
    });

    it('reintento tras timeout del cliente: exactamente una aplicación', async () => {
      const user = await h.newUser();
      const r = await h.approvedProposal(user);
      const abort = new AbortController();
      const control = await h.owner.connect();
      await control.query('BEGIN');
      await control.query(`SELECT 1 FROM cases WHERE id = $1 FOR UPDATE`, [
        r.caseId,
      ]);
      const timedOut = user.a
        .post(applyPath(r), {}, { signal: abort.signal })
        .catch((e: Error) => e.name);
      await h.waitBlocked(1);
      abort.abort();
      expect(await timedOut).toBe('AbortError');
      const retry = user.b.post(applyPath(r));
      await h.waitBlocked(2);
      await control.query('ROLLBACK');
      control.release();
      expect([200, 201]).toContain((await retry).status);
      await expect
        .poll(() => artifacts(r))
        .toEqual({ applications: 1, occurrences: 1, applied: 1 });
    });

    it('el trabajo hitl.decision se completa después de aplicar y no repite nada', async () => {
      const user = await h.newUser();
      const r = await h.approvedProposal(user);
      expect((await user.a.post(applyPath(r))).status).toBe(201);
      await h.apiA.service.post(
        `/internal/workflow-jobs/${r.job.id}/complete`,
        {
          claimToken: r.job.claimToken,
        },
      );
      const decisionJob = await h.claimOf(r.caseId, 'worker-decision', {
        jobTypes: ['hitl.decision'],
      });
      expect(decisionJob.jobType).toBe('hitl.decision');
      const done = await h.apiA.service.post(
        `/internal/workflow-jobs/${decisionJob.id}/complete`,
        { claimToken: decisionJob.claimToken, result: { applied: true } },
      );
      expect(done.status).toBe(200);
      const closed = await h.apiA.service.post(
        `/internal/cases/${r.caseId}/complete`,
        { jobId: decisionJob.id, claimToken: decisionJob.claimToken },
      );
      // El trabajo ya no tiene reclamación vigente: el orden correcto es cerrar
      // el caso ANTES de completar el trabajo (documentado para n8n).
      expect(closed.status).toBe(409);
      expect(await artifacts(r)).toEqual({
        applications: 1,
        occurrences: 1,
        applied: 1,
      });
    });
  });
});
