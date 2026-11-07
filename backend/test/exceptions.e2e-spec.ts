import request from 'supertest';
import { samplePdf } from './support/sample-files.js';
import {
  type ClaimedJob,
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import type { TestUser } from './support/pglite.js';

/**
 * Etapa 7 · Fase 3: la parte de las excepciones E1–E15 y de las reglas
 * R1–R17 que decide el BACKEND (fuente de verdad). La parte que decide el
 * workflow (interpretación, abstención, inyección) está en
 * n8n/tests/agent-eval.test.mjs. Se verifica el estado persistido, no lo que
 * "dice" el agente.
 */
describe('Exceptions E1–E15 · backend decisions (e2e)', () => {
  let w: ProcessWorld;
  const { sql, drainQueue, newCase, claim } = processHelpers(() => w);
  const svc = () => w.h.asService();
  const ref = (job: ClaimedJob) => ({
    jobId: job.id,
    claimToken: job.claimToken,
  });
  const count = async (q: string, p: unknown[] = []) =>
    Number(Object.values((await sql(q, p))[0]!)[0]);

  /** Simula el resultado del workflow: propuesta + revisión + decisión. */
  const proposeAndApprove = async (
    user: TestUser,
    proposedData: object,
    { approve = true, decisionType = 'data_confirmation', source = 'llm' } = {},
  ) => {
    await drainQueue();
    const c = await newCase(user);
    const [job] = await claim('worker-1');
    const p = (
      await svc()
        .post(`/internal/cases/${c.id}/proposals`, {
          ...ref(job!),
          source,
          proposedData,
        })
        .expect(201)
    ).body;
    const r = (
      await svc()
        .post(`/internal/cases/${c.id}/hitl-requests`, {
          ...ref(job!),
          decisionType,
          proposalId: p.id,
          options: { summary: 'Revisa' },
        })
        .expect(201)
    ).body;
    if (approve) {
      await w.h
        .as(user)
        .post(`/hitl-requests/${r.id}/decision`, { decision: 'approved' })
        .expect(200);
    }
    return { c, p, r };
  };
  const apply = (user: TestUser, caseId: string, proposalId: string) =>
    w.h.as(user).post(`/cases/${caseId}/proposals/${proposalId}/apply`);
  const businessCounts = () =>
    sql(
      `SELECT (SELECT count(*)::int FROM obligations) AS o, (SELECT count(*)::int FROM obligation_occurrences) AS p`,
    );
  const newObligation = (
    provider: string,
    period: string,
    amount: string,
    due: string,
  ) => ({
    action: 'create_obligation_with_occurrence',
    data: {
      obligation: {
        providerName: provider,
        concept: 'Servicio',
        category: 'electricity',
        expectedAmount: amount,
        currency: 'COP',
      },
      occurrence: {
        periodStart: `${period}-01`,
        periodEnd: `${period}-28`,
        dueDate: due,
        amount,
      },
    },
  });

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);
  afterAll(async () => {
    await w.h.app.close();
  });

  it('E3: the same file uploaded twice is flagged to the worker; a business duplicate is never created', async () => {
    const upload = (requestId: string) =>
      request(w.h.app.getHttpServer())
        .post('/api/v1/ingestions/documents')
        .set('Authorization', `Bearer ${w.h.tokenFor(w.laura)}`)
        .field('requestId', requestId)
        .attach('file', samplePdf('Factura E3 duplicada'), {
          filename: 'f.pdf',
          contentType: 'application/pdf',
        });
    const first = (
      await upload('3f0b7b1e-0d7a-4c55-9f43-3c3c5b6f2a01').expect(201)
    ).body;
    const second = (
      await upload('3f0b7b1e-0d7a-4c55-9f43-3c3c5b6f2a02').expect(201)
    ).body;
    expect(second.duplicateContent).toBe(true);
    const [job] = await sql<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_jobs WHERE case_id = $1`,
      [second.caseId],
    );
    expect(job!.payload.duplicateOfDocumentId).toBe(first.documentId);
    // Negocio: la segunda aplicación de la misma obligación responde 409.
    const one = await proposeAndApprove(
      w.camila,
      newObligation('Energía E3 S.A.', '2027-01', '50000.00', '2027-01-20'),
    );
    await apply(w.camila, one.c.id, one.p.id).expect(201);
    const before = await businessCounts();
    const two = await proposeAndApprove(
      w.camila,
      newObligation('Energía E3 S.A.', '2027-01', '50000.00', '2027-01-20'),
    );
    const res = await apply(w.camila, two.c.id, two.p.id).expect(409);
    expect(res.body.message).toMatch(/misma obligación|mismo proveedor/);
    expect(await businessCounts()).toEqual(before);
  });

  it('E7: two candidate obligations (two internet services) — the proposal never picks one', async () => {
    const internet = (propertyName: string) =>
      w.h
        .as(w.andres)
        .post('/obligations', {
          providerName: 'Internet Andino',
          concept: `Internet ${propertyName}`,
          category: 'internet',
        })
        .expect(201);
    await internet('Apto 101');
    await internet('Apto 202');
    const before = await businessCounts();
    // Sin obligación en el caso, el workflow solo puede proponer una nueva:
    // aplicarla con el mismo proveedor exige que la persona elija (409).
    const x = await proposeAndApprove(w.andres, {
      action: 'create_obligation_with_occurrence',
      data: {
        obligation: {
          providerName: 'Internet Andino',
          concept: 'Internet Apto 101',
          category: 'internet',
        },
        occurrence: {
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          dueDate: '2026-10-22',
          amount: '96300.00',
        },
      },
    });
    await apply(w.andres, x.c.id, x.p.id).expect(409);
    expect(await businessCounts()).toEqual(before);
  });

  it('E8/R5: opening a payment portal is not paying — the period stays open after any number of evaluations', async () => {
    const occ = (
      await w.h
        .as(w.laura)
        .post(`/obligations/${w.lauraObligation}/occurrences`, {
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
          dueDate: '2026-01-20',
          amount: '145000.00',
        })
        .expect(201)
    ).body;
    for (let i = 0; i < 3; i++)
      await svc()
        .post('/internal/alerts/evaluate', { workerId: 'n8n' })
        .expect(200);
    const [row] = await sql<{ status: string; confirmed_by: string | null }>(
      `SELECT status, confirmed_by FROM obligation_occurrences WHERE id = $1`,
      [occ.id],
    );
    expect(['pending', 'overdue']).toContain(row!.status);
    expect(row!.confirmed_by).toBeNull();
    expect(
      await count(
        `SELECT count(*) FROM alerts WHERE occurrence_id = $1 AND type = 'obligation_overdue' AND state = 'active'`,
        [occ.id],
      ),
    ).toBe(1);
    // R6: solo la confirmación humana lo marca pagado, con su autor.
    await w.h
      .as(w.laura)
      .post(`/obligations/${w.lauraObligation}/occurrences/${occ.id}/confirm`, {
        result: 'paid',
      })
      .expect(200);
    const [after] = await sql<{ status: string; confirmed_by: string }>(
      `SELECT status, confirmed_by FROM obligation_occurrences WHERE id = $1`,
      [occ.id],
    );
    expect(after).toEqual({ status: 'paid', confirmed_by: w.laura.profileId });
  });

  it('E9/R7/R9: an overdue rent charge stays unreceived and followed up until the owner confirms', async () => {
    for (let i = 0; i < 2; i++)
      await svc()
        .post('/internal/alerts/evaluate', { workerId: 'n8n' })
        .expect(200);
    const [charge] = await sql<{ status: string; confirmed_by: string | null }>(
      `SELECT status, confirmed_by FROM rent_charges WHERE id = $1`,
      [w.andresCharge],
    );
    expect(charge!.status).not.toBe('received');
    expect(charge!.confirmed_by).toBeNull();
    expect(
      await count(
        `SELECT count(*) FROM alerts WHERE rent_charge_id = $1 AND state = 'active'`,
        [w.andresCharge],
      ),
    ).toBe(1);
  });

  it('E10/R8: there is no channel to message a tenant; a reminder approval that expires sends nothing', async () => {
    // No existe ninguna ruta de envío de mensajes (ni de usuario ni interna).
    for (const path of [
      '/messages',
      '/reminders/send',
      '/internal/messages',
      '/internal/notifications/send',
      '/rentals/x/reminders',
    ]) {
      const r = await w.h.as(w.andres).post(path, {});
      expect([401, 404]).toContain(r.status);
    }
    await drainQueue();
    const c = (
      await w.h
        .as(w.andres)
        .post('/cases', { type: 'rent_collection', rentalId: w.andresRental })
        .expect(201)
    ).body;
    const [job] = await claim('worker-1');
    const r = (
      await svc()
        .post(`/internal/cases/${c.id}/hitl-requests`, {
          ...ref(job!),
          decisionType: 'reminder_approval',
          options: { summary: 'Borrador de recordatorio para el arrendatario' },
        })
        .expect(201)
    ).body;
    await sql(
      `UPDATE hitl_requests SET created_at = now() - interval '25 hours', due_at = now() - interval '1 hour' WHERE id = $1`,
      [r.id],
    );
    await svc()
      .post('/internal/hitl-requests/expire', { workerId: 'n8n' })
      .expect(200);
    const events = await sql<{ action: string }>(
      `SELECT action FROM audit_events WHERE correlation_id = $1`,
      [c.correlationId],
    );
    expect(events.map((e) => e.action).join()).not.toMatch(
      /send|message|deliver|notify/,
    );
    const [charge] = await sql<{ status: string }>(
      `SELECT status FROM rent_charges WHERE id = $1`,
      [w.andresCharge],
    );
    expect(charge!.status).not.toBe('received');
  });

  it('E11/R11: contract dates are never replaced by automation; contract cases cannot apply anything', async () => {
    await drainQueue();
    const c = (
      await w.h
        .as(w.camila)
        .post('/cases', {
          type: 'contract_review',
          contractId: w.camilaContract,
        })
        .expect(201)
    ).body;
    const [job] = await claim('worker-1');
    const p = (
      await svc()
        .post(`/internal/cases/${c.id}/proposals`, {
          ...ref(job!),
          source: 'llm',
          proposedData: {
            interpretacion: {
              fechaFinContrato: '2026-12-15',
              fechaRegistrada: '2026-11-30',
            },
            requiereRevisionManual: true,
          },
        })
        .expect(201)
    ).body;
    const r = (
      await svc()
        .post(`/internal/cases/${c.id}/hitl-requests`, {
          ...ref(job!),
          decisionType: 'contract_review',
          proposalId: p.id,
          options: {
            summary:
              'La fecha registrada (30/11/2026) difiere de la del contrato (15/12/2026)',
            choices: [
              { key: 'registrada', label: '30/11/2026 (registrada)' },
              { key: 'contrato', label: '15/12/2026 (documento)' },
            ],
          },
        })
        .expect(201)
    ).body;
    await w.h
      .as(w.camila)
      .post(`/hitl-requests/${r.id}/decision`, {
        decision: 'approved',
        choice: 'contrato',
      })
      .expect(200);
    await apply(w.camila, c.id, p.id).expect(409);
    const contract = (
      await w.h.as(w.camila).get(`/contracts/${w.camilaContract}`).expect(200)
    ).body;
    expect(contract).toMatchObject({ endsOn: '2026-12-15', status: 'active' }); // sin cambios
  });

  it('E12: voice (180.000) vs Gmail (188.420) for the same bill — nothing is applied until the person resolves', async () => {
    const before = await businessCounts();
    // Nota de voz: monto 180.000, fecha ambigua ("el 15") → revisión manual.
    const voice = await proposeAndApprove(
      w.laura,
      {
        interpretacion: {
          providerName: 'Energía de Prueba',
          amount: '180000.00',
          dueDate: null,
          currency: 'COP',
        },
        camposProblematicos: ['fecha de vencimiento'],
        requiereRevisionManual: true,
      },
      { approve: false, decisionType: 'other' },
    );
    // Factura de Gmail aplicable: 188.420, vence 17/10/2026.
    const gmail = await proposeAndApprove(
      w.laura,
      newObligation(
        'Energía de Prueba S.A. E.S.P.',
        '2026-09',
        '188420.00',
        '2026-10-17',
      ),
    );
    const res = await apply(w.laura, gmail.c.id, gmail.p.id).expect(409);
    expect(res.body).toMatchObject({
      code: 'CONTRADICTING_SOURCE',
      proposed: { amount: '188420.00', dueDate: '2026-10-17' },
    });
    expect(res.body.conflicts).toEqual([
      expect.objectContaining({
        caseId: voice.c.id,
        proposalId: voice.p.id,
        amount: '180000.00',
        dueDate: null,
      }),
    ]);
    expect(await businessCounts()).toEqual(before);
    // La persona rechaza la versión de voz → ya se puede aplicar la de Gmail.
    await w.h
      .as(w.laura)
      .post(`/hitl-requests/${voice.r.id}/decision`, { decision: 'rejected' })
      .expect(200);
    await apply(w.laura, gmail.c.id, gmail.p.id).expect(201);
  });

  it('E15/R17: no API returns or stores a payment link coming from AI', async () => {
    const res = await w.h
      .as(w.laura)
      .get(`/obligations/${w.lauraObligation}`)
      .expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\//);
    // Un campo de enlace en una propuesta aplicable se rechaza al aplicar.
    const p = await proposeAndApprove(w.laura, {
      action: 'create_obligation_occurrence',
      data: {
        obligationId: w.lauraObligation,
        periodStart: '2031-03-01',
        periodEnd: '2031-03-31',
        dueDate: '2031-03-20',
        amount: '1000.00',
        paymentUrl: 'https://pagos-falsos.example/pse',
      },
    });
    await apply(w.laura, p.c.id, p.p.id).expect(400);
    expect(await count(`SELECT count(*) FROM provider_payment_links`)).toBe(0);
  });

  it('R1/R3: incomplete structured input is refused; complete input is registered', async () => {
    await w.h
      .as(w.laura)
      .post('/obligations', { concept: 'Sin proveedor', category: 'water' })
      .expect(400);
    await w.h
      .as(w.laura)
      .post(`/obligations/${w.lauraObligation}/occurrences`, {
        periodStart: '2032-01-01',
      })
      .expect(400);
    await w.h
      .as(w.laura)
      .post(`/obligations/${w.lauraObligation}/occurrences`, {
        periodStart: '2032-01-01',
        periodEnd: '2031-12-01',
        dueDate: '2032-01-10',
      })
      .expect(400);
    await w.h
      .as(w.laura)
      .post('/obligations', {
        providerName: 'Gas Demo',
        concept: 'Gas',
        category: 'gas',
        expectedAmount: '-5.00',
      })
      .expect(400);
    await w.h
      .as(w.laura)
      .post('/obligations', {
        providerName: 'Gas Demo',
        concept: 'Gas',
        category: 'gas',
      })
      .expect(201);
  });
});
