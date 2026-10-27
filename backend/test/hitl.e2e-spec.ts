import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service.js';
import type { TestUser } from './support/pglite.js';
import {
  type ClaimedJob,
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Propuestas de IA y revisiones humanas (HITL), de punta a punta:
 * caso → trabajo → propuesta → revisión → decisión. Ninguna propuesta ni
 * aprobación modifica datos financieros.
 */
describe('Proposals and HITL (e2e)', () => {
  let w: ProcessWorld;
  const {
    sql,
    countAudit,
    drainQueue,
    newCase,
    claim,
    expireLease,
    makeOverdue,
  } = processHelpers(() => w);
  const svc = () => w.h.asService();

  /** Caso nuevo del usuario con su trabajo inicial ya reclamado por el worker. */
  const startCase = async (user: TestUser, body: object = {}) => {
    await drainQueue();
    const c = await newCase(user, body);
    const [job] = await claim('worker-1');
    expect(job!.case.id).toBe(c.id);
    return { c, job: job! };
  };

  const claimRef = (job: ClaimedJob) => ({
    jobId: job.id,
    claimToken: job.claimToken,
  });

  const propose = (caseId: string, job: ClaimedJob, body: object = {}) =>
    svc().post(`/internal/cases/${caseId}/proposals`, {
      ...claimRef(job),
      source: 'llm',
      proposedData: { amount: '145000.00', dueDate: '2026-11-18' },
      confidence: '0.870',
      ...body,
    });

  const OPTIONS = {
    summary: 'La factura muestra dos valores posibles',
    choices: [
      { key: 'amount_a', label: '$145.000' },
      { key: 'amount_b', label: '$154.000' },
    ],
  };

  const requestReview = (caseId: string, job: ClaimedJob, body: object = {}) =>
    svc().post(`/internal/cases/${caseId}/hitl-requests`, {
      ...claimRef(job),
      decisionType: 'data_confirmation',
      options: OPTIONS,
      ...body,
    });

  /** Caso con propuesta y revisión pendientes. */
  const reviewScenario = async (user: TestUser = w.laura) => {
    const { c, job } = await startCase(user);
    const proposal = (await propose(c.id, job).expect(201)).body;
    const review = (
      await requestReview(c.id, job, { proposalId: proposal.id }).expect(201)
    ).body;
    return { c, job, proposal, review };
  };

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);

  afterAll(async () => {
    await w.h.app.close();
    await w.t.client.close();
  });

  describe('proposals', () => {
    it('stores a pending proposal for the claimed case and audits it', async () => {
      const { c, job } = await startCase(w.laura);
      const res = await propose(c.id, job).expect(201);
      expect(res.body).toMatchObject({
        caseId: c.id,
        version: 1,
        source: 'llm',
        proposedData: { amount: '145000.00', dueDate: '2026-11-18' },
        confidence: '0.870',
        reviewStatus: 'pending_review',
        reviewedAt: null,
        reviewedBy: null,
      });
      expect(res.body).not.toHaveProperty('ownerId');
      const [row] = await sql<{ owner_id: string }>(
        'SELECT owner_id FROM case_proposals WHERE id = $1',
        [res.body.id],
      );
      expect(row!.owner_id).toBe(w.laura.profileId);

      const [event] = await sql<Record<string, unknown>>(
        `SELECT actor_type, actor_id, correlation_id, metadata FROM audit_events WHERE action = 'case_proposal.create' AND metadata->>'resourceId' = $1`,
        [res.body.id],
      );
      expect(event).toMatchObject({
        actor_type: 'workflow',
        actor_id: 'n8n:worker-1',
        correlation_id: c.correlationId,
        metadata: { appliedToBusinessData: false, version: 1 },
      });
      // La auditoría no copia los datos propuestos.
      expect(JSON.stringify(event)).not.toContain('145000.00');

      const list = (
        await w.h.as(w.laura).get(`/cases/${c.id}/proposals`).expect(200)
      ).body;
      expect(list.items.map((p: { id: string }) => p.id)).toEqual([
        res.body.id,
      ]);
      await w.h.as(w.andres).get(`/cases/${c.id}/proposals`).expect(404);
    });

    it('returns the same version for an identical retry and versions changes', async () => {
      const { c, job } = await startCase(w.laura);
      const v1 = (await propose(c.id, job).expect(201)).body;
      const retry = await propose(c.id, job).expect(200);
      expect(retry.body.id).toBe(v1.id);
      // Mismo contenido con otro orden de claves y confianza equivalente.
      await propose(c.id, job, {
        proposedData: { dueDate: '2026-11-18', amount: '145000.00' },
        confidence: '0.87',
      }).expect(200);

      const v2 = (
        await propose(c.id, job, {
          proposedData: { amount: '154000.00' },
        }).expect(201)
      ).body;
      expect(v2.version).toBe(2);
      const all = (
        await w.h.as(w.laura).get(`/cases/${c.id}/proposals`).expect(200)
      ).body.items;
      expect(
        all.map((p: { version: number; reviewStatus: string }) => [
          p.version,
          p.reviewStatus,
        ]),
      ).toEqual([
        [1, 'superseded'],
        [2, 'pending_review'],
      ]);
      const pending = (
        await w.h
          .as(w.laura)
          .get(`/cases/${c.id}/proposals?reviewStatus=pending_review`)
          .expect(200)
      ).body;
      expect(pending.total).toBe(1);
    });

    it('requires a current claim on a job of the same case', async () => {
      const a = await startCase(w.laura);
      const b = await newCase(w.andres, { type: 'rent_collection' });
      // Trabajo de otro caso (de otro propietario): no da acceso al caso B.
      await propose(b.id, a.job).expect(404);
      await propose(a.c.id, { ...a.job, claimToken: 'C'.repeat(43) }).expect(
        409,
      );
      await propose(randomUUID(), a.job).expect(404);
      await expireLease(a.job.id);
      await propose(a.c.id, a.job).expect(409);
      const [{ n }] = await sql<{ n: string }>(
        'SELECT count(*) AS n FROM case_proposals WHERE case_id IN ($1, $2)',
        [a.c.id, b.id],
      );
      expect(Number(n)).toBe(0);
    });

    it.each([
      ['user source', { source: 'user' }],
      ['unknown source', { source: 'gpt' }],
      ['array data', { proposedData: [1] }],
      ['null data', { proposedData: null }],
      ['oversized data', { proposedData: { text: 'x'.repeat(17_000) } }],
      ['confidence above 1', { confidence: '1.5' }],
      ['numeric confidence', { confidence: 0.5 }],
      ['client review status', { reviewStatus: 'accepted' }],
      ['client owner', { ownerId: randomUUID() }],
      ['client version', { version: 7 }],
      ['missing claim', { jobId: undefined }],
    ])('rejects an invalid proposal (%s) with 400', async (_c, body) => {
      const { c, job } = await startCase(w.laura);
      await propose(c.id, job, body).expect(400);
    });

    it('cannot confirm a rent charge or change business data', async () => {
      const { c, job } = await startCase(w.andres, {
        type: 'rent_collection',
        rentalId: w.andresRental,
      });
      await propose(c.id, job, {
        proposedData: {
          table: 'rent_charges',
          id: w.andresCharge,
          status: 'received',
          ownerId: w.laura.profileId,
        },
      }).expect(201);
      const charge = (
        await w.h
          .as(w.andres)
          .get(`/rentals/${w.andresRental}/charges/${w.andresCharge}`)
          .expect(200)
      ).body;
      expect(charge).toMatchObject({ status: 'expected', confirmedBy: null });
    });
  });

  describe('HITL requests', () => {
    it('creates a review assigned to the case owner with a 24-hour SLA', async () => {
      const { c, review } = await reviewScenario();
      expect(review).toMatchObject({
        caseId: c.id,
        decisionType: 'data_confirmation',
        status: 'pending',
        overdue: false,
        options: OPTIONS,
        decision: null,
        respondedAt: null,
      });
      const sla =
        new Date(review.dueAt).getTime() - new Date(review.createdAt).getTime();
      expect(sla).toBe(24 * 60 * 60 * 1000);
      const [row] = await sql<{ owner_id: string; assigned_to: string }>(
        'SELECT owner_id, assigned_to FROM hitl_requests WHERE id = $1',
        [review.id],
      );
      expect(row).toEqual({
        owner_id: w.laura.profileId,
        assigned_to: w.laura.profileId,
      });
      expect(
        (await w.h.as(w.laura).get(`/cases/${c.id}`).expect(200)).body.status,
      ).toBe('awaiting_human');
      expect(await countAudit('hitl_request.create', review.id)).toBe(1);
    });

    it('returns the existing review for an identical retry', async () => {
      const { c, job, proposal, review } = await reviewScenario();
      const retry = await requestReview(c.id, job, {
        proposalId: proposal.id,
      }).expect(200);
      expect(retry.body.id).toBe(review.id);
    });

    it.each([
      ['unknown decision type', { decisionType: 'payment' }],
      ['missing summary', { options: { choices: OPTIONS.choices } }],
      [
        'duplicate choice keys',
        {
          options: {
            summary: 's',
            choices: [
              { key: 'a', label: 'A' },
              { key: 'a', label: 'B' },
            ],
          },
        },
      ],
      [
        'bad choice key',
        { options: { summary: 's', choices: [{ key: 'A B', label: 'x' }] } },
      ],
      ['client assignee', { assignedTo: randomUUID() }],
      ['client due date', { dueAt: '2030-01-01T00:00:00Z' }],
      ['client status', { status: 'approved' }],
    ])('rejects an invalid review request (%s) with 400', async (_c, body) => {
      const { c, job } = await startCase(w.laura);
      await requestReview(c.id, job, body).expect(400);
    });

    it('rejects a proposal from another case (404)', async () => {
      const other = await reviewScenario();
      const { c, job } = await startCase(w.laura);
      await requestReview(c.id, job, { proposalId: other.proposal.id }).expect(
        404,
      );
    });

    it('is visible and decidable only by its assignee', async () => {
      const { review } = await reviewScenario(w.camila);
      await w.h.as(w.camila).get(`/hitl-requests/${review.id}`).expect(200);
      await w.h.as(w.andres).get(`/hitl-requests/${review.id}`).expect(404);
      await w.h
        .as(w.andres)
        .post(`/hitl-requests/${review.id}/decision`, {
          decision: 'approved',
          choice: 'amount_a',
        })
        .expect(404);
      const list = (await w.h.as(w.andres).get('/hitl-requests').expect(200))
        .body;
      expect(list.items.some((r: { id: string }) => r.id === review.id)).toBe(
        false,
      );
      expect(
        (await w.h.as(w.camila).get(`/hitl-requests/${review.id}`).expect(200))
          .body.status,
      ).toBe('pending');
    });
  });

  describe('decisions', () => {
    it('approves explicitly: records actor and time, accepts the proposal, resumes the case', async () => {
      const { c, proposal, review } = await reviewScenario();
      const before = Date.now();
      const res = await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, {
          decision: 'approved',
          choice: 'amount_a',
          comment: 'El valor correcto es el primero',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'approved',
        decision: {
          outcome: 'approved',
          choice: 'amount_a',
          comment: 'El valor correcto es el primero',
        },
        proposal: {
          id: proposal.id,
          reviewStatus: 'accepted',
          reviewedBy: w.laura.profileId,
        },
      });
      const respondedAt = new Date(res.body.respondedAt).getTime();
      expect(Math.abs(respondedAt - before)).toBeLessThan(10_000);

      expect(
        (await w.h.as(w.laura).get(`/cases/${c.id}`).expect(200)).body.status,
      ).toBe('processing');
      const [job] = await sql<{
        job_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT job_type, payload FROM workflow_jobs WHERE idempotency_key = $1`,
        [`hitl-decision:${review.id}`],
      );
      expect(job).toMatchObject({
        job_type: 'hitl.decision',
        payload: {
          hitlRequestId: review.id,
          decision: 'approved',
          choice: 'amount_a',
        },
      });
      const [event] = await sql<Record<string, unknown>>(
        `SELECT actor_type, actor_id, correlation_id FROM audit_events WHERE action = 'hitl_request.approve' AND metadata->>'resourceId' = $1`,
        [review.id],
      );
      expect(event).toEqual({
        actor_type: 'user',
        actor_id: w.laura.profileId,
        correlation_id: c.correlationId,
      });
    });

    it('rejects explicitly and never turns the rejection into an approval', async () => {
      const { proposal, review } = await reviewScenario();
      const res = await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, { decision: 'rejected' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'rejected',
        decision: { outcome: 'rejected' },
        proposal: { id: proposal.id, reviewStatus: 'rejected' },
      });
      await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, {
          decision: 'approved',
          choice: 'amount_a',
        })
        .expect(409);
      expect(await countAudit('hitl_request.approve', review.id)).toBe(0);
    });

    it('repeats an identical decision without a new event, and rejects a contradictory one', async () => {
      const { review } = await reviewScenario();
      const path = `/hitl-requests/${review.id}/decision`;
      const body = { decision: 'approved', choice: 'amount_b' };
      const first = await w.h.as(w.laura).post(path, body).expect(200);
      const again = await w.h.as(w.laura).post(path, body).expect(200);
      expect(again.body.respondedAt).toBe(first.body.respondedAt);
      await w.h
        .as(w.laura)
        .post(path, { decision: 'approved', choice: 'amount_a' })
        .expect(409);
      await w.h.as(w.laura).post(path, { decision: 'rejected' }).expect(409);
      expect(await countAudit('hitl_request.approve', review.id)).toBe(1);
    });

    it.each([
      ['approval without choice', { decision: 'approved' }],
      ['unknown choice', { decision: 'approved', choice: 'amount_z' }],
      ['rejection with choice', { decision: 'rejected', choice: 'amount_a' }],
      ['unknown decision', { decision: 'maybe' }],
      [
        'client timestamp',
        { decision: 'rejected', respondedAt: '2020-01-01T00:00:00Z' },
      ],
      ['client actor', { decision: 'rejected', decidedBy: randomUUID() }],
      ['expired as decision', { decision: 'expired' }],
    ])('rejects an invalid decision (%s) with 400', async (_c, body) => {
      const { review } = await reviewScenario();
      await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, body)
        .expect(400);
      expect(
        (await w.h.as(w.laura).get(`/hitl-requests/${review.id}`).expect(200))
          .body.status,
      ).toBe('pending');
    });

    it('lets only one of two concurrent contradictory decisions win', async () => {
      const { review } = await reviewScenario();
      const path = `/hitl-requests/${review.id}/decision`;
      const responses = await Promise.all([
        w.h
          .as(w.laura)
          .post(path, { decision: 'approved', choice: 'amount_a' }),
        w.h.as(w.laura).post(path, { decision: 'rejected' }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const decided =
        (await countAudit('hitl_request.approve', review.id)) +
        (await countAudit('hitl_request.reject', review.id));
      expect(decided).toBe(1);
    });

    it('refuses to approve after the deadline, records the expiry and stops the case', async () => {
      const { c, proposal, review } = await reviewScenario();
      await makeOverdue(review.id);
      expect(
        (await w.h.as(w.laura).get(`/hitl-requests/${review.id}`).expect(200))
          .body,
      ).toMatchObject({ status: 'pending', overdue: true });

      const res = await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, {
          decision: 'approved',
          choice: 'amount_a',
        })
        .expect(409);
      expect(res.body.message).toMatch(/venció/);
      const after = (
        await w.h.as(w.laura).get(`/hitl-requests/${review.id}`).expect(200)
      ).body;
      expect(after).toMatchObject({
        status: 'expired',
        decision: null,
        respondedAt: null,
        proposal: { id: proposal.id, reviewStatus: 'pending_review' },
      });
      expect(await countAudit('hitl_request.expire', review.id)).toBe(1);
      expect(await countAudit('hitl_request.approve', review.id)).toBe(0);
      const closed = (await w.h.as(w.laura).get(`/cases/${c.id}`).expect(200))
        .body;
      expect(closed).toMatchObject({
        status: 'failed',
        statusReason: 'La revisión humana venció sin decisión',
      });
      // Vencida es final: tampoco puede rechazarse ya.
      await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, { decision: 'rejected' })
        .expect(409);
    });

    it('materializes expiries through the internal sweep, never as approvals', async () => {
      const { review } = await reviewScenario(w.andres);
      const fresh = await reviewScenario(w.andres);
      await makeOverdue(review.id);
      const res = await svc()
        .post('/internal/hitl-requests/expire', { workerId: 'scheduler' })
        .expect(200);
      expect(res.body.expired).toContain(review.id);
      expect(res.body.expired).not.toContain(fresh.review.id);
      const again = await svc()
        .post('/internal/hitl-requests/expire', { workerId: 'scheduler' })
        .expect(200);
      expect(again.body.expired).not.toContain(review.id);
      const [row] = await sql<{ status: string; decision: unknown }>(
        'SELECT status, decision FROM hitl_requests WHERE id = $1',
        [review.id],
      );
      expect(row).toEqual({ status: 'expired', decision: null });
      await svc()
        .post('/internal/hitl-requests/expire', { workerId: 'a#b' })
        .expect(400);
    });

    it('cancels a pending review when its proposal is superseded', async () => {
      const { c, job, review } = await reviewScenario();
      await propose(c.id, job, { proposedData: { amount: '999.00' } }).expect(
        201,
      );
      const after = (
        await w.h.as(w.laura).get(`/hitl-requests/${review.id}`).expect(200)
      ).body;
      expect(after).toMatchObject({
        status: 'cancelled',
        proposal: { reviewStatus: 'superseded' },
      });
      expect(
        (await w.h.as(w.laura).get(`/cases/${c.id}`).expect(200)).body.status,
      ).toBe('processing');
      await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, {
          decision: 'approved',
          choice: 'amount_a',
        })
        .expect(409);
    });

    it('approving never modifies financial data', async () => {
      const { c, job } = await startCase(w.andres, {
        type: 'rent_collection',
        rentalId: w.andresRental,
      });
      const proposal = (
        await propose(c.id, job, {
          proposedData: { chargeId: w.andresCharge, markAsReceived: true },
        }).expect(201)
      ).body;
      const review = (
        await requestReview(c.id, job, {
          proposalId: proposal.id,
          options: { summary: '¿Registrar el cobro como recibido?' },
        }).expect(201)
      ).body;
      await w.h
        .as(w.andres)
        .post(`/hitl-requests/${review.id}/decision`, { decision: 'approved' })
        .expect(200);
      const charge = (
        await w.h
          .as(w.andres)
          .get(`/rentals/${w.andresRental}/charges/${w.andresCharge}`)
          .expect(200)
      ).body;
      expect(charge).toMatchObject({ status: 'expected', confirmedAt: null });
    });
  });

  describe('case closing by the workflow', () => {
    it('cannot complete with pending reviews; completes after the decision', async () => {
      const { c, job, review } = await reviewScenario();
      const path = `/internal/cases/${c.id}/complete`;
      await svc().post(path, claimRef(job)).expect(409);
      await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, { decision: 'rejected' })
        .expect(200);
      const done = await svc().post(path, claimRef(job)).expect(200);
      expect(done.body).toMatchObject({ status: 'completed' });
      expect(done.body.closedAt).not.toBeNull();
      const again = await svc().post(path, claimRef(job)).expect(200);
      expect(again.body.closedAt).toBe(done.body.closedAt);
      await svc()
        .post(`/internal/cases/${c.id}/fail`, { ...claimRef(job), reason: 'x' })
        .expect(409);
      await propose(c.id, job).expect(409);
      // El trabajo pendiente de la decisión quedó anulado con el cierre.
      const [pending] = await sql<{ status: string }>(
        `SELECT status FROM workflow_jobs WHERE idempotency_key = $1`,
        [`hitl-decision:${review.id}`],
      );
      expect(pending!.status).toBe('cancelled');
    });

    it('fails a case with a sanitized reason and cancels its pending reviews', async () => {
      const { c, job, review } = await reviewScenario();
      const res = await svc()
        .post(`/internal/cases/${c.id}/fail`, {
          ...claimRef(job),
          reason: 'OCR failed: password=hunter2',
        })
        .expect(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.statusReason).not.toContain('hunter2');
      expect(
        (await w.h.as(w.laura).get(`/hitl-requests/${review.id}`).expect(200))
          .body.status,
      ).toBe('cancelled');
    });
  });

  describe('correlation and atomicity', () => {
    it('links case, job, proposal, review and decision through one correlation_id', async () => {
      const { c, review } = await reviewScenario();
      await w.h
        .as(w.laura)
        .post(`/hitl-requests/${review.id}/decision`, {
          decision: 'approved',
          choice: 'amount_a',
        })
        .expect(200);
      const actions = (
        await sql<{ action: string }>(
          'SELECT DISTINCT action FROM audit_events WHERE correlation_id = $1',
          [c.correlationId],
        )
      ).map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'case.create',
          'workflow_job.create',
          'workflow_job.claim',
          'case.status_change',
          'case_proposal.create',
          'hitl_request.create',
          'hitl_request.approve',
          'case_proposal.accept',
        ]),
      );
    });

    describe('with a failing audit store', () => {
      let failing: TestApp;

      beforeAll(async () => {
        const reject = () =>
          Promise.reject(new Error('audit storage unavailable'));
        failing = await createTestApp(w.t.db, (b) =>
          b.overrideProvider(AuditService).useValue({
            recordUserAction: reject,
            recordAutomatedAction: reject,
          }),
        );
      });

      afterAll(async () => {
        await failing.app.close();
      });

      it('rolls back proposals, review requests and decisions', async () => {
        const { c, job, review } = await reviewScenario();
        const counts = async () =>
          (
            await sql(
              `SELECT (SELECT count(*) FROM case_proposals WHERE case_id = $1) AS p, (SELECT count(*) FROM hitl_requests WHERE case_id = $1) AS r`,
              [c.id],
            )
          )[0];
        const before = await counts();
        await failing
          .asService()
          .post(`/internal/cases/${c.id}/proposals`, {
            ...claimRef(job),
            source: 'ocr',
            proposedData: { other: true },
          })
          .expect(500);
        await failing
          .asService()
          .post(`/internal/cases/${c.id}/hitl-requests`, {
            ...claimRef(job),
            decisionType: 'other',
            options: { summary: 'otra' },
          })
          .expect(500);
        expect(await counts()).toEqual(before);

        await failing
          .as(w.laura)
          .post(`/hitl-requests/${review.id}/decision`, {
            decision: 'approved',
            choice: 'amount_a',
          })
          .expect(500);
        const after = (
          await w.h.as(w.laura).get(`/hitl-requests/${review.id}`).expect(200)
        ).body;
        expect(after).toMatchObject({
          status: 'pending',
          decision: null,
          proposal: { reviewStatus: 'pending_review' },
        });
      });
    });
  });
});
