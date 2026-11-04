import { addDays, calendarDateIn } from '../../src/due-dates/calendar.js';
import { samplePdf, sampleWav } from '../support/sample-files.js';
import {
  type ClaimedJob,
  Harness,
  httpClient,
  recordEvidence,
  type User,
} from './support/harness.js';

const today = () => calendarDateIn(new Date(), 'America/Bogota');

/**
 * Simulación HTTP de lo que hará n8n (Fase 4.2G). No hay n8n, IA ni
 * transcripción: `SimulatedWorker` usa solo rutas internas públicas del
 * contrato y sus "procesadores" devuelven fixtures fijos. Nada real se invoca.
 */
class SimulatedWorker {
  constructor(
    private readonly h: Harness,
    readonly id: string,
    private readonly api = h.apiA,
  ) {}

  private get service() {
    return this.api.service;
  }

  async claim(jobType: string, caseId: string): Promise<ClaimedJob> {
    const res = await this.service.post('/internal/workflow-jobs/claim', {
      workerId: this.id,
      jobTypes: [jobType],
      limit: 5,
    });
    expect(res.status).toBe(200);
    const job = (res.body.jobs as ClaimedJob[]).find(
      (j) => j.case.id === caseId,
    );
    expect(job, `${this.id} no recibió el trabajo`).toBeDefined();
    return job!;
  }

  download(documentId: string, job: ClaimedJob) {
    return this.service.download(`/internal/documents/${documentId}/content`, {
      headers: { 'x-job-id': job.id, 'x-claim-token': job.claimToken },
    });
  }

  propose(job: ClaimedJob, source: string, proposedData: object, extra = {}) {
    return this.service.post(`/internal/cases/${job.case.id}/proposals`, {
      jobId: job.id,
      claimToken: job.claimToken,
      source,
      proposedData,
      ...extra,
    });
  }

  requestReview(job: ClaimedJob, proposalId: string) {
    return this.service.post(`/internal/cases/${job.case.id}/hitl-requests`, {
      jobId: job.id,
      claimToken: job.claimToken,
      decisionType: 'data_confirmation',
      proposalId,
      options: { summary: 'Confirma los datos propuestos (fixture de prueba)' },
    });
  }

  complete(job: ClaimedJob, result: object) {
    return this.service.post(`/internal/workflow-jobs/${job.id}/complete`, {
      claimToken: job.claimToken,
      result,
    });
  }

  closeCase(job: ClaimedJob) {
    return this.service.post(`/internal/cases/${job.case.id}/complete`, {
      jobId: job.id,
      claimToken: job.claimToken,
    });
  }
}

describe('Simulación HTTP de los flujos futuros de n8n', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());
  beforeEach(() => h.drainQueue());

  const auditTrail = (correlationId: string) =>
    h
      .sql<{
        action: string;
        actor_type: string;
        actor_id: string;
        result: string;
      }>(
        `SELECT action, actor_type, actor_id, result FROM audit_events
          WHERE correlation_id = $1 ORDER BY occurred_at, id`,
        [correlationId],
      )
      .then((rows) => rows);

  const realLogin = async (user: User) => {
    const res = await httpClient(h.apiA.baseUrl).post('/auth/login', {
      email: user.email,
      password: user.password,
    });
    expect(res.status).toBe(200);
    return httpClient(h.apiB.baseUrl, `Bearer ${res.body.accessToken}`);
  };

  it('Flujo A: factura PDF → propuesta → HITL → aplicación → vencimientos', async () => {
    const synth = await h.newUser('factura', true);
    const intruder = await h.newUser('intruso');
    // Paso 1: inicio de sesión real con credenciales sintéticas.
    const session = await realLogin(synth);
    const obligationRes = await session.post('/obligations', {
      providerName: 'Empresa ficticia de energía',
      concept: 'Energía',
      category: 'electricity',
      expectedAmount: '145000.00',
    });
    const obligationId = obligationRes.body.id as string;

    // Paso 2-3: subida; NestJS registra documento, caso y trabajo.
    const pdf = samplePdf('Factura ficticia de prueba: fixture');
    const requestId = crypto.randomUUID();
    const upload = await session.upload(
      '/ingestions/documents',
      { name: 'factura.pdf', type: 'application/pdf', bytes: pdf },
      { requestId, obligationId },
    );
    expect(upload.status).toBe(201);
    const { caseId, documentId, correlationId } = upload.body as {
      caseId: string;
      documentId: string;
      correlationId: string;
    };
    expect(upload.body.processing).toBe('pending');
    // Un reintento de la subida no duplica nada.
    const retry = await session.upload(
      '/ingestions/documents',
      { name: 'factura.pdf', type: 'application/pdf', bytes: pdf },
      { requestId, obligationId },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.caseId).toBe(caseId);

    // Paso 4-5: el worker reclama y lee el PDF con su reclamación vigente.
    const worker = new SimulatedWorker(h, 'n8n-sim-1');
    const job = await worker.claim('document.process', caseId);
    expect(job.status).toBe('claimed');
    const file = await worker.download(documentId, job);
    expect(file.status).toBe(200);
    expect(file.bytes).toEqual(pdf);
    // El PDF sigue siendo privado para otros propietarios.
    expect(
      (await intruder.a.download(`/documents/${documentId}/content`)).status,
    ).toBe(404);

    // Paso 6-7: "procesador" simulado (FIXTURE fijo, sin OCR ni IA).
    const dueDate = addDays(today(), 3);
    const start = `${dueDate.slice(0, 8)}01`;
    const fixture = {
      action: 'create_obligation_occurrence',
      data: {
        obligationId,
        periodStart: start,
        periodEnd: dueDate,
        dueDate,
        amount: '152300.00',
        currency: 'COP',
      },
    };
    const proposal = await worker.propose(job, 'llm', fixture, {
      documentId,
      confidence: '0.900',
      evidence: { source: 'fixture-de-prueba' },
    });
    expect(proposal.status).toBe(201);
    const proposalId = proposal.body.id as string;

    // Antes de la autorización humana no existe ningún período.
    const periods = () =>
      h.count(
        `SELECT count(*) AS n FROM obligation_occurrences WHERE obligation_id = $1`,
        [obligationId],
      );
    expect(await periods()).toBe(0);
    expect(
      (await session.post(`/cases/${caseId}/proposals/${proposalId}/apply`))
        .status,
    ).toBe(409);

    // Paso 8-9: revisión HITL y consulta del usuario.
    const review = await worker.requestReview(job, proposalId);
    expect(review.status).toBe(201);
    const reviewId = review.body.id as string;
    const detail = await session.get(`/hitl-requests/${reviewId}`);
    expect(detail.body.proposal.proposedData).toEqual(fixture);
    expect(detail.body.status).toBe('pending');
    const attention = await session.get('/attention');
    expect(
      (attention.body.items as { id: string }[]).map((i) => i.id),
    ).toContain(reviewId);
    expect(
      (await worker.complete(job, { stage: 'awaiting_human' })).status,
    ).toBe(200);

    // Paso 10-12: aprobación humana y aplicación controlada; período pendiente.
    const decision = await session.post(`/hitl-requests/${reviewId}/decision`, {
      decision: 'approved',
    });
    expect(decision.status).toBe(200);
    expect(await periods()).toBe(0);
    const [applied, repeated] = await Promise.all([
      session.post(`/cases/${caseId}/proposals/${proposalId}/apply`),
      session.post(`/cases/${caseId}/proposals/${proposalId}/apply`),
    ]);
    expect([applied!.status, repeated!.status].sort()).toEqual([200, 201]);
    expect(await periods()).toBe(1);
    const [period] = await h.sql(
      `SELECT id, status, amount, confirmed_at FROM obligation_occurrences WHERE obligation_id = $1`,
      [obligationId],
    );
    expect(period).toMatchObject({
      status: 'pending',
      amount: '152300.00',
      confirmed_at: null,
    });

    // Paso 13: el trabajo hitl.decision sigue la máquina de estados real.
    const followUp = await worker.claim('hitl.decision', caseId);
    expect(followUp.attempts).toBe(1);
    const closed = await worker.closeCase(followUp);
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('completed');
    expect((await worker.complete(followUp, { stage: 'applied' })).status).toBe(
      200,
    );

    // Paso 14-15: el motor de vencimientos lo identifica; todo es coherente.
    const evaluation = await h.apiB.service.post('/internal/alerts/evaluate', {
      workerId: 'n8n-sim-scheduler',
    });
    expect(evaluation.status).toBe(200);
    const alerts = await session.get('/alerts?state=active');
    const alert = (
      alerts.body.items as { type: string; resource: { id: string } }[]
    ).find((a) => a.resource.id === period!.id);
    expect(alert?.type).toBe('obligation_due_soon');
    const tray = await session.get('/attention');
    expect((tray.body.items as { id: string }[]).map((i) => i.id)).toContain(
      period!.id,
    );
    const dashboard = await session.get('/dashboard/summary');
    expect(dashboard.body.obligations.periodsPending).toBe(1);
    expect(dashboard.body.obligations.periodsConfirmed).toBe(0);

    // Una propuesta anterior o un segundo intento no generan otro período.
    expect(
      (await session.post(`/cases/${caseId}/proposals/${proposalId}/apply`))
        .status,
    ).toBe(200);
    expect(await periods()).toBe(1);

    // Paso 16: el proceso se reconstruye con correlation_id.
    const trail = await auditTrail(correlationId);
    const actions = trail.map((e) => e.action);
    for (const action of [
      'case.create',
      'document.receive',
      'workflow_job.create',
      'workflow_job.claim',
      'document.content_access',
      'case_proposal.create',
      'hitl_request.create',
      'hitl_request.approve',
      'case_proposal.accept',
      'case_proposal.apply',
      'obligation_occurrence.create',
      'workflow_job.complete',
      'case.status_change',
    ]) {
      expect(actions, action).toContain(action);
    }
    expect(actions.indexOf('hitl_request.approve')).toBeLessThan(
      actions.indexOf('obligation_occurrence.create'),
    );
    expect(actions).not.toContain('obligation_occurrence.confirm');
    const approve = trail.find((e) => e.action === 'hitl_request.approve')!;
    expect(approve).toMatchObject({
      actor_type: 'user',
      actor_id: synth.profileId,
    });
    expect(
      trail.find((e) => e.action === 'case_proposal.create')!.actor_id,
    ).toBe('n8n:n8n-sim-1');
    recordEvidence('flow-a-audit-trail', { actions });
  });

  it('Flujo B: nota de voz → voice.transcribe → propuesta stt → revisión sin efectos', async () => {
    const user = await h.newUser('voz');
    const intruder = await h.newUser('intruso');
    const audio = sampleWav();
    const up = await user.a.upload('/ingestions/voice', {
      name: 'nota.wav',
      type: 'audio/wav',
      bytes: audio,
    });
    expect(up.status).toBe(201);
    const { caseId, documentId, correlationId } = up.body as {
      caseId: string;
      documentId: string;
      correlationId: string;
    };
    expect(up.body.source).toBe('voice');
    expect(up.body.job.type).toBe('voice.transcribe');
    const [doc] = await h.sql(
      `SELECT type, source FROM documents WHERE id = $1`,
      [documentId],
    );
    expect(doc).toEqual({ type: 'voice_note', source: 'voice' });

    const worker = new SimulatedWorker(h, 'n8n-sim-stt');
    const job = await worker.claim('voice.transcribe', caseId);
    const file = await worker.download(documentId, job);
    expect(file.status).toBe(200);
    expect(file.bytes).toEqual(audio);
    expect(
      (await intruder.a.download(`/documents/${documentId}/content`)).status,
    ).toBe(404);

    // "Transcripción" simulada: texto FIJO de prueba, el audio no se procesa.
    const transcript = {
      text: 'Fixture fijo de transcripción, no es audio real',
    };
    const stt = await worker.propose(job, 'stt', transcript, { documentId });
    expect(stt.status).toBe(201);
    expect(stt.body.source).toBe('stt');
    expect(stt.body.reviewStatus).toBe('pending_review');
    const review = await worker.requestReview(job, stt.body.id as string);
    expect(review.status).toBe(201);

    // Una transcripción no es una acción permitida: aprobada no se aplica.
    const decision = await user.a.post(
      `/hitl-requests/${review.body.id}/decision`,
      { decision: 'approved' },
    );
    expect(decision.status).toBe(200);
    const apply = await user.a.post(
      `/cases/${caseId}/proposals/${stt.body.id}/apply`,
    );
    expect(apply.status).toBe(400);
    expect(
      await h.count(
        `SELECT count(*) AS n FROM obligations WHERE owner_id = $1`,
        [user.profileId],
      ),
    ).toBe(0);

    // Un worker antiguo no puede continuar con la nota de voz.
    await h.expireLease(job.id);
    expect((await worker.download(documentId, job)).status).toBe(409);
    expect((await worker.complete(job, { late: true })).status).toBe(409);
    // El intento rechazado de aplicar queda auditado como `failure`, no como éxito.
    const trail = (await auditTrail(correlationId))
      .filter((e) => e.result === 'success')
      .map((e) => e.action);
    expect(trail).toContain('voice_note.receive');
    expect(trail).not.toContain('obligation_occurrence.create');
    expect(trail).not.toContain('case_proposal.apply');
  });

  it('Flujo C: fallo y recuperación con respuesta tardía rechazada', async () => {
    const user = await h.newUser('recuperacion');
    const c = await h.newCase(user);
    const first = new SimulatedWorker(h, 'n8n-sim-first', h.apiA);
    const second = new SimulatedWorker(h, 'n8n-sim-second', h.apiB);
    const stale = await first.claim('case.household_obligation', c.id);
    // El primero se interrumpe y su arrendamiento vence.
    await h.expireLease(stale.id);
    const current = await second.claim('case.household_obligation', c.id);
    expect(current.id).toBe(stale.id);
    expect(current.attempts).toBe(2);
    // Su respuesta tardía se rechaza en todas las rutas.
    const late = await Promise.all([
      first.complete(stale, { from: 'tarde' }),
      first.propose(stale, 'llm', { tarde: true }),
    ]);
    expect(late.map((r) => r.status)).toEqual([409, 409]);
    expect((await second.closeCase(current)).status).toBe(200);
    expect((await second.complete(current, { from: 'vigente' })).status).toBe(
      200,
    );
    expect((await h.job(stale.id)).result).toEqual({ from: 'vigente' });
    const trail = await auditTrail(c.correlationId);
    const completes = trail.filter((e) => e.action === 'workflow_job.complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]!.actor_id).toBe('n8n:n8n-sim-second');
    expect(trail.filter((e) => e.action === 'workflow_job.claim')).toHaveLength(
      2,
    );
    expect(
      await h.count(
        `SELECT count(*) AS n FROM case_proposals WHERE case_id = $1`,
        [c.id],
      ),
    ).toBe(0);
  });

  it('Flujo D: rechazo humano sin modificar obligaciones ni cobros', async () => {
    const user = await h.newUser('rechazo');
    const rental = await h.rental(user);
    const charge = await h.charge(user, rental);
    const r = await h.pendingReview(user);
    const before = await h.sql(
      `SELECT (SELECT count(*) FROM obligation_occurrences WHERE owner_id = $1) AS periods,
              (SELECT status FROM rent_charges WHERE id = $2) AS charge`,
      [user.profileId, charge],
    );
    const decision = await user.a.post(
      `/hitl-requests/${r.reviewId}/decision`,
      {
        decision: 'rejected',
        comment: 'Los datos no corresponden (prueba)',
      },
    );
    expect(decision.status).toBe(200);
    expect(decision.body.status).toBe('rejected');
    const [proposal] = await h.sql(
      `SELECT review_status, reviewed_by FROM case_proposals WHERE id = $1`,
      [r.proposalId],
    );
    expect(proposal).toEqual({
      review_status: 'rejected',
      reviewed_by: user.profileId,
    });
    const apply = await user.a.post(
      `/cases/${r.caseId}/proposals/${r.proposalId}/apply`,
    );
    expect(apply.status).toBe(409);
    expect(
      await h.sql(
        `SELECT (SELECT count(*) FROM obligation_occurrences WHERE owner_id = $1) AS periods,
                (SELECT status FROM rent_charges WHERE id = $2) AS charge`,
        [user.profileId, charge],
      ),
    ).toEqual(before);
    const trail = (await auditTrail(r.correlationId)).map((e) => e.action);
    expect(trail).toContain('hitl_request.reject');
    expect(trail).toContain('case_proposal.reject');
    // El rechazo también llega al worker como un trabajo, sin ejecutar nada.
    const worker = new SimulatedWorker(h, 'n8n-sim-reject');
    const followUp = await worker.claim('hitl.decision', r.caseId);
    expect(
      (followUp as unknown as { payload: { decision: string } }).payload
        .decision,
    ).toBe('rejected');
  });
});
