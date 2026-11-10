import {
  type ClaimedJob,
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';

/**
 * Etapa 7 · Fase 5: SLA de 24 h de la revisión humana con reloj controlado
 * (el plazo lo evalúa PostgreSQL con clock_timestamp(); se mueve `due_at`).
 * Antes, exactamente en y después del límite; caducidad pendiente frente a
 * procesada; decisión tardía. El silencio nunca equivale a aprobación.
 */
describe('HITL 24 h SLA boundaries (e2e)', () => {
  let w: ProcessWorld;
  const { sql, drainQueue, newCase, claim } = processHelpers(() => w);
  const svc = () => w.h.asService();
  const ref = (job: ClaimedJob) => ({
    jobId: job.id,
    claimToken: job.claimToken,
  });

  /** Caso con propuesta aplicable y revisión pendiente de Laura. */
  const pendingReview = async () => {
    await drainQueue();
    const c = await newCase(w.laura);
    const [job] = await claim('worker-1');
    const p = (
      await svc()
        .post(`/internal/cases/${c.id}/proposals`, {
          ...ref(job!),
          source: 'llm',
          proposedData: {
            action: 'create_obligation_occurrence',
            data: {
              obligationId: w.lauraObligation,
              periodStart: `20${50 + Math.floor(Math.random() * 40)}-0${1 + Math.floor(Math.random() * 8)}-01`,
              periodEnd: '2099-12-31',
              dueDate: '2099-12-20',
              amount: '1000.00',
            },
          },
        })
        .expect(201)
    ).body;
    const r = (
      await svc()
        .post(`/internal/cases/${c.id}/hitl-requests`, {
          ...ref(job!),
          decisionType: 'data_confirmation',
          proposalId: p.id,
          options: { summary: 'Confirma los datos' },
        })
        .expect(201)
    ).body;
    return { c, job: job!, p, r };
  };
  const setDue = (id: string, expr: string) =>
    sql(
      `UPDATE hitl_requests SET created_at = now() - interval '30 hours', due_at = ${expr} WHERE id = $1`,
      [id],
    );
  const row = async (id: string) =>
    (
      await sql<{
        status: string;
        decision: unknown;
        responded_at: Date | null;
      }>(
        `SELECT status, decision, responded_at FROM hitl_requests WHERE id = $1`,
        [id],
      )
    )[0]!;
  const decide = (id: string, decision = 'approved') =>
    w.h.as(w.laura).post(`/hitl-requests/${id}/decision`, { decision });

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);
  afterAll(async () => {
    await w.h.app.close();
  });

  it('is created with a 24-hour deadline set by the server', async () => {
    const { r } = await pendingReview();
    const hours =
      (new Date(r.dueAt).getTime() - new Date(r.createdAt).getTime()) / 3.6e6;
    expect(hours).toBeCloseTo(24, 3);
    expect(r).toMatchObject({ status: 'pending', overdue: false });
  });

  it('before the limit (1 minute left): the decision is accepted', async () => {
    const { r } = await pendingReview();
    await setDue(r.id, `now() + interval '1 minute'`);
    await decide(r.id).expect(200);
    expect((await row(r.id)).status).toBe('approved');
  });

  it('exactly at the limit (due_at = now): it is already late — never approved', async () => {
    const { r } = await pendingReview();
    await setDue(r.id, `now()`);
    const detail = (
      await w.h.as(w.laura).get(`/hitl-requests/${r.id}`).expect(200)
    ).body;
    expect(detail.overdue).toBe(true);
    await decide(r.id).expect(409);
    expect(await row(r.id)).toEqual({
      status: 'expired',
      decision: null,
      responded_at: null,
    });
  });

  it('after the limit, still pending (not swept): the late decision materializes the expiry', async () => {
    const { c, r } = await pendingReview();
    await setDue(r.id, `now() - interval '1 hour'`);
    expect((await row(r.id)).status).toBe('pending'); // caducidad pendiente
    await decide(r.id, 'rejected').expect(409); // ni aprobar ni rechazar
    expect((await row(r.id)).status).toBe('expired');
    const [caseRow] = await sql<{ status: string; status_reason: string }>(
      `SELECT status, status_reason FROM cases WHERE id = $1`,
      [c.id],
    );
    expect(caseRow).toMatchObject({ status: 'failed' });
    expect(caseRow!.status_reason).toMatch(/venció/);
  });

  it('after the limit, processed by the sweep: later decisions are refused and nothing is applied', async () => {
    const { c, p, r } = await pendingReview();
    await setDue(r.id, `now() - interval '2 hours'`);
    const sweep = await svc()
      .post('/internal/hitl-requests/expire', { workerId: 'n8n-scheduler' })
      .expect(200);
    expect(sweep.body.expired).toContain(r.id);
    expect((await row(r.id)).status).toBe('expired');
    await decide(r.id).expect(409);
    await w.h
      .as(w.laura)
      .post(`/cases/${c.id}/proposals/${p.id}/apply`)
      .expect(409);
    const [proposal] = await sql<{ review_status: string }>(
      `SELECT review_status FROM case_proposals WHERE id = $1`,
      [p.id],
    );
    expect(proposal!.review_status).toBe('pending_review'); // nunca 'accepted'
    // La auditoría registra el vencimiento como sistema, no como aprobación.
    const actions = (
      await sql<{ action: string; actor_type: string }>(
        `SELECT action, actor_type FROM audit_events WHERE metadata->>'resourceId' = $1 ORDER BY occurred_at`,
        [r.id],
      )
    ).map((e) => `${e.action}:${e.actor_type}`);
    expect(actions).toContain('hitl_request.expire:workflow');
    expect(actions.join()).not.toMatch(/approve/);
  });

  it('the sweep is idempotent and skips reviews decided in time', async () => {
    const decided = await pendingReview();
    await decide(decided.r.id).expect(200);
    const late = await pendingReview();
    await setDue(late.r.id, `now() - interval '1 hour'`);
    await svc()
      .post('/internal/hitl-requests/expire', { workerId: 'n8n-scheduler' })
      .expect(200);
    const again = await svc()
      .post('/internal/hitl-requests/expire', { workerId: 'n8n-scheduler' })
      .expect(200);
    expect(again.body.expired).toEqual([]);
    expect((await row(decided.r.id)).status).toBe('approved');
    expect((await row(late.r.id)).status).toBe('expired');
  });

  it('the frontend gets what it needs to show an expired case', async () => {
    const { r } = await pendingReview();
    await setDue(r.id, `now() - interval '1 hour'`);
    await svc()
      .post('/internal/hitl-requests/expire', { workerId: 'n8n-scheduler' })
      .expect(200);
    const detail = (
      await w.h.as(w.laura).get(`/hitl-requests/${r.id}`).expect(200)
    ).body;
    expect(detail).toMatchObject({
      status: 'expired',
      decision: null,
      respondedAt: null,
      overdue: false,
    });
    expect(detail.proposal).toBeTruthy();
    expect(new Date(detail.dueAt).getTime()).toBeLessThan(Date.now());
  });
});
