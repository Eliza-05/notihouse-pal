import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service.js';
import { createTestUser, type TestUser } from './support/pglite.js';
import {
  type ClaimedJob,
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import { createTestApp } from './support/test-app.js';

interface ReviewOptions {
  caseBody?: object;
  decisionType?: string;
  choices?: boolean;
  decision?: 'approved' | 'rejected' | null;
  source?: 'llm' | 'ocr' | 'stt';
}

/**
 * Aplicación controlada de propuestas aprobadas: solo acciones de la lista
 * permitida, con los datos aprobados, exactamente una vez y con auditoría
 * transaccional. Ningún JSON de IA puede producir escrituras arbitrarias.
 */
describe('Proposal application (e2e)', () => {
  let w: ProcessWorld;
  let daniel: TestUser;
  let andresObligation: string;
  const { sql, countAudit, drainQueue, newCase, claim, makeOverdue } =
    processHelpers(() => w);
  const svc = () => w.h.asService();
  const ref = (job: ClaimedJob) => ({
    jobId: job.id,
    claimToken: job.claimToken,
  });

  let year = 2030;
  /** Período nuevo y único para cada prueba. */
  const nextPeriod = () => {
    year += 1;
    return {
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-01-31`,
      dueDate: `${year}-01-18`,
    };
  };
  const occurrenceAction = (data: object = {}) => ({
    action: 'create_obligation_occurrence',
    data: {
      obligationId: w.lauraObligation,
      ...nextPeriod(),
      amount: '152300.00',
      ...data,
    },
  });

  const count = async (query: string, params: unknown[] = []) =>
    Number((await sql<{ n: string }>(query, params))[0]!.n);
  const occurrencesOf = (obligationId: string) =>
    count(
      `SELECT count(*) AS n FROM obligation_occurrences WHERE obligation_id = $1`,
      [obligationId],
    );
  const failures = (proposalId: string) =>
    count(
      `SELECT count(*) AS n FROM audit_events WHERE action = 'case_proposal.apply' AND result = 'failure' AND metadata->>'resourceId' = $1`,
      [proposalId],
    );

  /** Caso → propuesta → revisión → decisión (por defecto, aprobada). */
  const reviewed = async (
    proposedData: object,
    options: ReviewOptions = {},
    user: TestUser = w.laura,
  ) => {
    await drainQueue();
    const c = await newCase(user, options.caseBody);
    const [job] = await claim('worker-1');
    const p = (
      await svc()
        .post(`/internal/cases/${c.id}/proposals`, {
          ...ref(job!),
          source: options.source ?? 'llm',
          proposedData,
          confidence: '0.910',
        })
        .expect(201)
    ).body;
    const r = (
      await svc()
        .post(`/internal/cases/${c.id}/hitl-requests`, {
          ...ref(job!),
          decisionType: options.decisionType ?? 'data_confirmation',
          proposalId: p.id,
          options: options.choices
            ? {
                summary: 'Dos valores posibles',
                choices: [
                  { key: 'a', label: 'A' },
                  { key: 'b', label: 'B' },
                ],
              }
            : { summary: 'Confirma los datos de la factura' },
        })
        .expect(201)
    ).body;
    const decision =
      options.decision === undefined ? 'approved' : options.decision;
    if (decision) {
      await w.h
        .as(user)
        .post(`/hitl-requests/${r.id}/decision`, {
          decision,
          ...(options.choices && decision === 'approved'
            ? { choice: 'a' }
            : {}),
        })
        .expect(200);
    }
    return { c, job: job!, p, r };
  };

  /**
   * Defensa en profundidad. Desde la Etapa 7 el registro interno rechaza una
   * propuesta con una operación prohibida (422) y activa el kill switch (ver
   * kill-switch.e2e-spec.ts), así que ya no puede llegar guardada por esa vía.
   * Para seguir comprobando que APLICAR también la rechaza si alguna vez
   * existiera (dato heredado, otra vía de escritura), se guarda una propuesta
   * válida, se aprueba con su revisión y luego se sustituye su contenido en
   * la base, simulando esa propuesta ya almacenada.
   */
  const reviewedStored = async (proposedData: object) => {
    const r = await reviewed(occurrenceAction());
    await sql(`UPDATE case_proposals SET proposed_data = $1 WHERE id = $2`, [
      JSON.stringify(proposedData),
      r.p.id,
    ]);
    return r;
  };

  const apply = (
    user: TestUser,
    caseId: string,
    proposalId: string,
    body: object = {},
  ) =>
    w.h.as(user).post(`/cases/${caseId}/proposals/${proposalId}/apply`, body);

  beforeAll(async () => {
    w = await createProcessWorld();
    daniel = await createTestUser(w.t.db, {
      email: 'daniel@notihouse.test',
      password: randomBytes(12).toString('base64url'),
      displayName: 'daniel',
    });
    andresObligation = (
      await w.h
        .as(w.andres)
        .post('/obligations', {
          providerName: 'Acueducto',
          concept: 'Agua',
          category: 'water',
        })
        .expect(201)
    ).body.id;
  }, 60_000);

  afterAll(async () => {
    await w.h.app.close();
  });

  describe('successful application', () => {
    it('creates a pending period from an approved proposal, with full traceability', async () => {
      const proposedData = occurrenceAction();
      const { c, p, r } = await reviewed(proposedData);
      const before = await occurrencesOf(w.lauraObligation);

      const res = await apply(w.laura, c.id, p.id).expect(201);
      expect(res.headers['x-correlation-id']).toBe(c.correlationId);
      expect(res.body).toMatchObject({
        caseId: c.id,
        proposalId: p.id,
        proposalVersion: 1,
        hitlRequestId: r.id,
        action: 'create_obligation_occurrence',
        status: 'applied',
        alreadyApplied: false,
        resource: {
          type: 'obligation_occurrence',
          obligationId: w.lauraObligation,
          status: 'pending',
        },
        createdObligationId: null,
        correlationId: c.correlationId,
      });
      expect(await occurrencesOf(w.lauraObligation)).toBe(before + 1);

      const [occ] = await sql(
        `SELECT status, amount, currency, period_start::text, due_date::text, confirmed_at, confirmed_by
           FROM obligation_occurrences WHERE id = $1`,
        [res.body.resource.id],
      );
      expect(occ).toEqual({
        status: 'pending',
        amount: '152300.00',
        currency: 'COP',
        period_start: proposedData.data.periodStart,
        due_date: proposedData.data.dueDate,
        confirmed_at: null,
        confirmed_by: null,
      });

      // Documento/voz → caso → propuesta → HITL → aprobación → aplicación.
      const actions = (
        await sql<{ action: string }>(
          `SELECT action FROM audit_events WHERE correlation_id = $1 AND result = 'success' ORDER BY occurred_at, action`,
          [c.correlationId],
        )
      ).map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'case.create',
          'case_proposal.create',
          'hitl_request.create',
          'hitl_request.approve',
          'case_proposal.accept',
          'case_proposal.apply',
          'obligation_occurrence.create',
        ]),
      );
      const [event] = await sql<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'obligation_occurrence.create' AND metadata->>'resourceId' = $1`,
        [res.body.resource.id],
      );
      expect(event!.metadata).toMatchObject({
        source: 'case_proposal',
        caseId: c.id,
        proposalId: p.id,
        hitlRequestId: r.id,
      });
      const [applied] = await sql<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'case_proposal.apply' AND metadata->>'resourceId' = $1`,
        [p.id],
      );
      expect(applied!.metadata).toMatchObject({
        occurrenceStatus: 'pending',
        humanApproval: true,
      });
      expect(JSON.stringify(applied!.metadata)).not.toContain('152300');
    });

    it('creates a new obligation with its first period when that is the approved action', async () => {
      const { c, p } = await reviewed({
        action: 'create_obligation_with_occurrence',
        data: {
          obligation: {
            providerName: 'Gas Natural',
            concept: 'Gas',
            category: 'gas',
            expectedAmount: '48000.00',
          },
          occurrence: nextPeriod(),
        },
      });
      const res = await apply(w.laura, c.id, p.id).expect(201);
      expect(res.body.createdObligationId).toBe(res.body.resource.obligationId);
      const obligation = (
        await w.h
          .as(w.laura)
          .get(`/obligations/${res.body.createdObligationId}`)
          .expect(200)
      ).body;
      expect(obligation).toMatchObject({
        providerName: 'Gas Natural',
        status: 'active',
        currency: 'COP',
      });
      expect(res.body.resource.status).toBe('pending');
      const [occ] = await sql(
        `SELECT amount FROM obligation_occurrences WHERE id = $1`,
        [res.body.resource.id],
      );
      expect(occ).toEqual({ amount: '48000.00' });

      // Otra propuesta con el mismo proveedor y concepto no duplica la obligación.
      const again = await reviewed({
        action: 'create_obligation_with_occurrence',
        data: {
          obligation: {
            providerName: 'gas natural',
            concept: 'GAS',
            category: 'gas',
          },
          occurrence: nextPeriod(),
        },
      });
      await apply(w.laura, again.c.id, again.p.id).expect(409);
      expect(
        await count(
          `SELECT count(*) AS n FROM obligations WHERE owner_id = $1 AND lower(concept) = 'gas'`,
          [w.laura.profileId],
        ),
      ).toBe(1);
    });
  });

  describe('HITL and proposal state', () => {
    it('rejects a proposal that was not approved yet', async () => {
      const { c, p } = await reviewed(occurrenceAction(), { decision: null });
      const before = await occurrencesOf(w.lauraObligation);
      await apply(w.laura, c.id, p.id).expect(409);
      expect(await occurrencesOf(w.lauraObligation)).toBe(before);
      expect(await failures(p.id)).toBe(1);
    });

    it('rejects a rejected proposal', async () => {
      const { c, p } = await reviewed(occurrenceAction(), {
        decision: 'rejected',
      });
      const res = await apply(w.laura, c.id, p.id).expect(409);
      expect(res.body.message).toMatch(/rechazada/);
    });

    it('rejects a superseded proposal and an outdated accepted version', async () => {
      // v1 pendiente reemplazada por v2.
      const { c, job, p } = await reviewed(occurrenceAction(), {
        decision: null,
      });
      const v2 = (
        await svc()
          .post(`/internal/cases/${c.id}/proposals`, {
            ...ref(job),
            source: 'llm',
            proposedData: occurrenceAction(),
          })
          .expect(201)
      ).body;
      expect(v2.version).toBe(2);
      const superseded = await apply(w.laura, c.id, p.id).expect(409);
      expect(superseded.body.message).toMatch(/reemplazada/);

      // v1 aprobada, pero después llegó una versión más reciente.
      const accepted = await reviewed(occurrenceAction());
      await svc()
        .post(`/internal/cases/${accepted.c.id}/proposals`, {
          ...ref(accepted.job),
          source: 'llm',
          proposedData: occurrenceAction(),
        })
        .expect(201);
      const outdated = await apply(
        w.laura,
        accepted.c.id,
        accepted.p.id,
      ).expect(409);
      expect(outdated.body.message).toMatch(/más reciente/);
    });

    it('requires an approved review linked to the proposal', async () => {
      const { c, p } = await reviewed(occurrenceAction(), { decision: null });
      // Aceptada sin una revisión aprobada (p. ej. un dato manipulado).
      await sql(
        `UPDATE case_proposals SET review_status = 'accepted', reviewed_at = now(), reviewed_by = owner_id WHERE id = $1`,
        [p.id],
      );
      const res = await apply(w.laura, c.id, p.id).expect(409);
      expect(res.body.message).toMatch(/aprobación humana válida/);
    });

    it('only accepts data_confirmation reviews without alternatives', async () => {
      const other = await reviewed(occurrenceAction(), {
        decisionType: 'other',
      });
      await apply(w.laura, other.c.id, other.p.id).expect(409);
      const reminder = await reviewed(occurrenceAction(), {
        decisionType: 'reminder_approval',
      });
      await apply(w.laura, reminder.c.id, reminder.p.id).expect(409);
      const choices = await reviewed(occurrenceAction(), { choices: true });
      const res = await apply(w.laura, choices.c.id, choices.p.id).expect(409);
      expect(res.body.message).toMatch(/alternativas/);
    });

    it('rejects approvals outside the deadline and expired reviews', async () => {
      const late = await reviewed(occurrenceAction());
      await sql(
        `UPDATE hitl_requests SET created_at = responded_at - interval '25 hours', due_at = responded_at - interval '1 hour' WHERE id = $1`,
        [late.r.id],
      );
      const res = await apply(w.laura, late.c.id, late.p.id).expect(409);
      expect(res.body.message).toMatch(/fuera de plazo/);

      const expired = await reviewed(occurrenceAction(), { decision: null });
      await makeOverdue(expired.r.id);
      await w.h
        .as(w.laura)
        .post(`/hitl-requests/${expired.r.id}/decision`, {
          decision: 'approved',
        })
        .expect(409);
      await apply(w.laura, expired.c.id, expired.p.id).expect(409);
    });
  });

  describe('ownership', () => {
    it('answers 404 to another user (Daniel cannot apply Laura’s proposal)', async () => {
      const { c, p } = await reviewed(occurrenceAction());
      const before = await occurrencesOf(w.lauraObligation);
      await apply(daniel, c.id, p.id).expect(404);
      await apply(w.andres, c.id, p.id).expect(404);
      expect(await occurrencesOf(w.lauraObligation)).toBe(before);
      // El rechazo por propiedad ajena no se registra en la cuenta del intruso.
      expect(await failures(p.id)).toBe(0);
    });

    it('answers 404 when the proposal belongs to another case', async () => {
      const { p } = await reviewed(occurrenceAction());
      const andresCase = await newCase(w.andres, { type: 'rent_collection' });
      await apply(w.andres, andresCase.id, p.id).expect(404);
      const otherLauraCase = await newCase(w.laura);
      await apply(w.laura, otherLauraCase.id, p.id).expect(404);
      await apply(w.laura, randomUUID(), p.id).expect(404);
      await apply(w.laura, otherLauraCase.id, 'not-a-uuid').expect(400);
    });

    it('never creates periods on missing or foreign obligations', async () => {
      const missing = await reviewed(
        occurrenceAction({ obligationId: randomUUID() }),
      );
      await apply(w.laura, missing.c.id, missing.p.id).expect(404);

      const foreign = await reviewed(
        occurrenceAction({ obligationId: andresObligation }),
      );
      await apply(w.laura, foreign.c.id, foreign.p.id).expect(404);
      expect(await occurrencesOf(andresObligation)).toBe(0);
    });

    it('rejects a proposal about a different obligation than the case', async () => {
      const second = (
        await w.h
          .as(w.laura)
          .post('/obligations', {
            providerName: 'Internet SAS',
            concept: 'Internet',
            category: 'internet',
          })
          .expect(201)
      ).body.id as string;
      const { c, p } = await reviewed(
        occurrenceAction({ obligationId: second }),
        {
          caseBody: { obligationId: w.lauraObligation },
        },
      );
      await apply(w.laura, c.id, p.id).expect(400);
      expect(await occurrencesOf(second)).toBe(0);
    });

    it('does not let the service token apply proposals', async () => {
      const { c, p } = await reviewed(occurrenceAction());
      await svc().post(`/cases/${c.id}/proposals/${p.id}/apply`).expect(401);
    });
  });

  describe('allow-listed actions only', () => {
    it.each([
      ['unknown action', { action: 'do_something', data: {} }],
      [
        'mark a period as paid',
        {
          action: 'mark_occurrence_paid',
          data: { occurrenceId: randomUUID() },
        },
      ],
      [
        'confirm a rent charge',
        {
          action: 'confirm_rent_charge',
          data: { rentChargeId: randomUUID(), evidence: 'x' },
        },
      ],
      [
        'renew a contract',
        {
          action: 'renew_contract',
          data: { contractId: randomUUID(), endsOn: '2030-01-01' },
        },
      ],
      [
        'change an owner',
        { action: 'change_owner', data: { ownerId: randomUUID() } },
      ],
      [
        'raw SQL',
        { action: 'sql', data: { query: 'DELETE FROM audit_events' } },
      ],
    ])('rejects %s (400) without writing', async (_label, proposedData) => {
      const { c, p } = await reviewedStored(proposedData);
      const before = await sql(
        `SELECT (SELECT count(*) FROM obligation_occurrences) AS o, (SELECT count(*) FROM proposal_applications) AS a`,
      );
      await apply(w.laura, c.id, p.id).expect(400);
      expect(
        await sql(
          `SELECT (SELECT count(*) FROM obligation_occurrences) AS o, (SELECT count(*) FROM proposal_applications) AS a`,
        ),
      ).toEqual(before);
      expect(await failures(p.id)).toBe(1);
    });

    it('never applies a transcription (stt), even shaped as an allowed action', async () => {
      const proposedData = occurrenceAction();
      const { c, p } = await reviewed(proposedData, { source: 'stt' });
      const periods = await occurrencesOf(w.lauraObligation);
      await apply(w.laura, c.id, p.id).expect(400);
      expect(await occurrencesOf(w.lauraObligation)).toBe(periods);
      expect(await failures(p.id)).toBe(1);
    });

    it('cannot mark periods paid, confirm income or renew contracts through data fields', async () => {
      const paid = await reviewedStored(
        occurrenceAction({ status: 'paid', confirmedBy: w.laura.profileId }),
      );
      const res = await apply(w.laura, paid.c.id, paid.p.id).expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/status|confirmedBy/);

      const charge = (
        await w.h
          .as(w.andres)
          .get(`/rentals/${w.andresRental}/charges/${w.andresCharge}`)
          .expect(200)
      ).body;
      expect(charge).toMatchObject({ status: 'expected', confirmedBy: null });
      const contract = (
        await w.h.as(w.camila).get(`/contracts/${w.camilaContract}`).expect(200)
      ).body;
      expect(contract).toMatchObject({
        status: 'active',
        endsOn: '2026-12-15',
      });
    });

    it('rejects invalid financial data and currency conversions', async () => {
      for (const data of [
        { amount: '-1.00' },
        { amount: 152300.5 },
        { dueDate: '2031-02-30' },
        { currency: 'USD' },
      ]) {
        const { c, p } = await reviewed(occurrenceAction(data));
        await apply(w.laura, c.id, p.id).expect(400);
      }
    });

    it('accepts no client payload that could replace approved data', async () => {
      const { c, p } = await reviewed(occurrenceAction());
      await apply(w.laura, c.id, p.id, { amount: '1.00' }).expect(400);
      await apply(w.laura, c.id, p.id, { ownerId: daniel.profileId }).expect(
        400,
      );
      expect(
        await count(
          `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
          [p.id],
        ),
      ).toBe(0);
    });

    it('only applies household obligation cases', async () => {
      await drainQueue();
      const c = await newCase(w.andres, { type: 'rent_collection' });
      const [job] = await claim('worker-1');
      const p = (
        await svc()
          .post(`/internal/cases/${c.id}/proposals`, {
            ...ref(job!),
            source: 'llm',
            proposedData: occurrenceAction({ obligationId: andresObligation }),
          })
          .expect(201)
      ).body;
      const r = (
        await svc()
          .post(`/internal/cases/${c.id}/hitl-requests`, {
            ...ref(job!),
            decisionType: 'data_confirmation',
            proposalId: p.id,
            options: { summary: 'Confirma' },
          })
          .expect(201)
      ).body;
      await w.h
        .as(w.andres)
        .post(`/hitl-requests/${r.id}/decision`, { decision: 'approved' })
        .expect(200);
      await apply(w.andres, c.id, p.id).expect(409);
      expect(await occurrencesOf(andresObligation)).toBe(0);
    });
  });

  describe('idempotency and concurrency', () => {
    it('rejects a duplicate period without altering the existing one', async () => {
      const period = nextPeriod();
      const existing = (
        await w.h
          .as(w.laura)
          .post(`/obligations/${w.lauraObligation}/occurrences`, {
            ...period,
            amount: '1000.00',
          })
          .expect(201)
      ).body;
      const { c, p } = await reviewed({
        action: 'create_obligation_occurrence',
        data: {
          obligationId: w.lauraObligation,
          ...period,
          amount: '99999.00',
        },
      });
      await apply(w.laura, c.id, p.id).expect(409);
      const [row] = await sql(
        `SELECT amount, status, updated_at = created_at AS untouched FROM obligation_occurrences WHERE id = $1`,
        [existing.id],
      );
      expect(row).toEqual({
        amount: '1000.00',
        status: 'pending',
        untouched: true,
      });
    });

    it('is idempotent on a double click or a retry after a timeout', async () => {
      const { c, p } = await reviewed(occurrenceAction());
      const first = await apply(w.laura, c.id, p.id).expect(201);
      const second = await apply(w.laura, c.id, p.id).expect(200);
      const retry = await w.h
        .as(w.laura)
        .post(`/cases/${c.id}/proposals/${p.id}/apply`)
        .set('X-Correlation-Id', randomUUID())
        .expect(200);
      for (const res of [second, retry]) {
        expect(res.body).toMatchObject({
          alreadyApplied: true,
          resource: first.body.resource,
          appliedAt: first.body.appliedAt,
          correlationId: c.correlationId,
        });
      }
      expect(
        await count(
          `SELECT count(*) AS n FROM obligation_occurrences WHERE obligation_id = $1 AND period_start = $2`,
          [
            w.lauraObligation,
            (
              await sql<{ s: string }>(
                `SELECT period_start::text AS s FROM obligation_occurrences WHERE id = $1`,
                [first.body.resource.id],
              )
            )[0]!.s,
          ],
        ),
      ).toBe(1);
      expect(await countAudit('case_proposal.apply', p.id)).toBe(1);
    });

    it('lets only one of several simultaneous requests apply the proposal', async () => {
      const { c, p } = await reviewed(occurrenceAction());
      const before = await occurrencesOf(w.lauraObligation);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => apply(w.laura, c.id, p.id)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.resource.id)).size).toBe(1);
      expect(await occurrencesOf(w.lauraObligation)).toBe(before + 1);
      expect(
        await count(
          `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
          [p.id],
        ),
      ).toBe(1);
      expect(await countAudit('case_proposal.apply', p.id)).toBe(1);
    });

    it('a delayed worker cannot apply the result again', async () => {
      const { c, p } = await reviewed(occurrenceAction());
      await apply(w.laura, c.id, p.id).expect(201);
      const after = await occurrencesOf(w.lauraObligation);

      const jobs = await claim('worker-late', { jobTypes: ['hitl.decision'] });
      const job = jobs.find((j) => j.case.id === c.id)!;
      expect(job).toBeDefined();
      await svc()
        .post(`/internal/workflow-jobs/${job.id}/complete`, {
          claimToken: job.claimToken,
          result: { applied: true, occurrence: occurrenceAction().data },
        })
        .expect(200);
      expect(await occurrencesOf(w.lauraObligation)).toBe(after);
      await apply(w.laura, c.id, p.id).expect(200);
      expect(await occurrencesOf(w.lauraObligation)).toBe(after);
    });

    it('preserves the proposal history', async () => {
      const { c, p } = await reviewed(occurrenceAction());
      const before = (
        await w.h.as(w.laura).get(`/cases/${c.id}/proposals`).expect(200)
      ).body;
      await apply(w.laura, c.id, p.id).expect(201);
      const after = (
        await w.h.as(w.laura).get(`/cases/${c.id}/proposals`).expect(200)
      ).body;
      expect(after).toEqual(before);
      expect(after.items[0]).toMatchObject({
        version: 1,
        reviewStatus: 'accepted',
      });
    });
  });

  describe('with a failing audit store', () => {
    it('rolls back the period, the obligation and the application', async () => {
      const reject = () =>
        Promise.reject(new Error('audit storage unavailable'));
      const failing = await createTestApp(w.t.db, (b) =>
        b.overrideProvider(AuditService).useValue({
          recordUserAction: reject,
          recordAutomatedAction: reject,
        }),
      );
      try {
        const { c, p } = await reviewed(occurrenceAction());
        const before = await occurrencesOf(w.lauraObligation);
        await failing
          .as(w.laura)
          .post(`/cases/${c.id}/proposals/${p.id}/apply`)
          .expect(500);
        expect(await occurrencesOf(w.lauraObligation)).toBe(before);
        expect(
          await count(
            `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
            [p.id],
          ),
        ).toBe(0);

        const withObligation = await reviewed({
          action: 'create_obligation_with_occurrence',
          data: {
            obligation: {
              providerName: 'Telefonía',
              concept: 'Móvil',
              category: 'mobile',
            },
            occurrence: nextPeriod(),
          },
        });
        await failing
          .as(w.laura)
          .post(
            `/cases/${withObligation.c.id}/proposals/${withObligation.p.id}/apply`,
          )
          .expect(500);
        expect(
          await count(
            `SELECT count(*) AS n FROM obligations WHERE concept = 'Móvil'`,
          ),
        ).toBe(0);

        // Recuperado el almacén de auditoría, la misma propuesta se aplica una vez.
        await apply(w.laura, c.id, p.id).expect(201);
        expect(await occurrencesOf(w.lauraObligation)).toBe(before + 1);
      } finally {
        await failing.app.close();
      }
    });

    it('rolls back the new obligation when its first period is invalid', async () => {
      const { c, p } = await reviewed({
        action: 'create_obligation_with_occurrence',
        data: {
          obligation: {
            providerName: 'TV',
            concept: 'Televisión',
            category: 'other',
          },
          occurrence: {
            periodStart: '2040-02-01',
            periodEnd: '2040-01-01',
            dueDate: '2040-02-10',
          },
        },
      });
      await apply(w.laura, c.id, p.id).expect(400);
      expect(
        await count(
          `SELECT count(*) AS n FROM obligations WHERE concept = 'Televisión'`,
        ),
      ).toBe(0);
    });
  });
});
