import { randomBytes, randomUUID } from 'node:crypto';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { createTestApp, type TestApp } from './support/test-app.js';

interface ClaimedTextJob {
  id: string;
  claimToken: string;
  case: { id: string };
}

/**
 * Archivado de obligaciones: manual (confirmación directa) y con IA + HITL
 * (propuesta → aprobación → aplicación). Ambos usan la misma regla
 * (`ObligationsService.archiveLocked`): nunca se borra nada, no se generan
 * períodos nuevos y los períodos existentes (pendientes o pagados) quedan
 * intactos. Sin Gemini: la extracción la simula el propio test.
 */
describe('Archive obligation (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let laura: TestUser;
  let andres: TestUser;

  const pw = () => randomBytes(12).toString('base64url');
  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => (await t.client.query<T>(query, params)).rows;
  const countRows = async (query: string, params: unknown[] = []) =>
    Number((await sql<{ n: string }>(query, params))[0]!.n);

  const newObligation = async (
    user: TestUser,
    over: Record<string, unknown> = {},
  ) =>
    (
      await h
        .as(user)
        .post('/obligations', {
          providerName: `Proveedor ${randomUUID().slice(0, 8)}`,
          concept: `Servicio ${randomUUID().slice(0, 8)}`,
          category: 'internet',
          expectedAmount: '75000.00',
          dueDay: 10,
          ...over,
        })
        .expect(201)
    ).body as { id: string; providerName: string; concept: string };

  const newOccurrence = async (
    user: TestUser,
    obligationId: string,
    periodStart: string,
    dueDate: string,
  ) =>
    (
      await h
        .as(user)
        .post(`/obligations/${obligationId}/occurrences`, {
          periodStart,
          periodEnd: periodStart.slice(0, 8) + '28',
          dueDate,
          amount: '75000.00',
        })
        .expect(201)
    ).body as { id: string };

  const statusOf = async (id: string) =>
    (await h.as(laura).get(`/obligations/${id}`).expect(200)).body.status;
  const auditCount = (action: string, resourceId: string) =>
    countRows(
      `SELECT count(*) AS n FROM audit_events WHERE action = $1 AND metadata->>'resourceId' = $2`,
      [action, resourceId],
    );
  const occurrenceSnapshot = (obligationId: string) =>
    sql(
      `SELECT id, period_start::text, due_date::text, amount, status, confirmed_at
         FROM obligation_occurrences WHERE obligation_id = $1 ORDER BY period_start`,
      [obligationId],
    );

  /** Mensaje de texto propio → trabajo reclamado (como lo hace n8n). */
  const sendAndClaim = async (user: TestUser): Promise<ClaimedTextJob> => {
    // Aísla la cola: los trabajos hitl.decision de pruebas previas no deben ocupar el lote.
    await sql(
      `UPDATE workflow_jobs SET status = 'cancelled', locked_until = NULL WHERE status IN ('pending', 'claimed')`,
    );
    const sent = (
      await h
        .as(user)
        .post('/ingestions/text', { text: `Mensaje ${randomUUID()}` })
        .expect(201)
    ).body as { caseId: string };
    const res = await h
      .asService()
      .post('/internal/workflow-jobs/claim', { workerId: 'n8n-qa' })
      .expect(200);
    return (res.body.jobs as ClaimedTextJob[]).find(
      (j) => j.case.id === sent.caseId,
    )!;
  };
  const resolve = (job: ClaimedTextJob, extraction: object) =>
    h.asService().post(`/internal/cases/${job.case.id}/assistant/resolve`, {
      jobId: job.id,
      claimToken: job.claimToken,
      extraction,
    });
  const ref = (job: ClaimedTextJob) => ({
    jobId: job.id,
    claimToken: job.claimToken,
  });
  const archiveExtraction = (over: object = {}) => ({
    intent: 'archive_obligation',
    ...over,
  });

  /** Como n8n: resolve → propuesta → revisión humana (aún sin decidir). */
  const proposeArchive = async (
    user: TestUser,
    extraction: object,
  ) => {
    const job = await sendAndClaim(user);
    const r = (await resolve(job, extraction).expect(200)).body;
    expect(r.outcome).toBe('applicable');
    const p = (
      await h
        .asService()
        .post(`/internal/cases/${job.case.id}/proposals`, {
          ...ref(job),
          source: 'llm',
          proposedData: r.proposedData,
        })
        .expect(201)
    ).body;
    const rev = (
      await h
        .asService()
        .post(`/internal/cases/${job.case.id}/hitl-requests`, {
          ...ref(job),
          decisionType: 'data_confirmation',
          proposalId: p.id,
          options: { summary: r.summary },
        })
        .expect(201)
    ).body;
    return { job, caseId: job.case.id, proposal: p, review: rev, resolved: r };
  };
  const decide = (user: TestUser, id: string, body: object) =>
    h.as(user).post(`/hitl-requests/${id}/decision`, body);
  const apply = (user: TestUser, caseId: string, proposalId: string) =>
    h.as(user).post(`/cases/${caseId}/proposals/${proposalId}/apply`);

  beforeAll(async () => {
    t = await createMigratedDatabase();
    h = await createTestApp(t.db);
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
  });

  beforeEach(async () => {
    [laura, andres] = await Promise.all(
      ['laura', 'andres'].map((n) =>
        createTestUser(t.db, {
          email: `${n}-${randomUUID()}@archive.test`,
          password: pw(),
          displayName: n,
        }),
      ),
    ) as [TestUser, TestUser];
  });

  describe('manual', () => {
    it('archives an active obligation, keeps every period and audits it', async () => {
      const o = await newObligation(laura);
      const pending = await newOccurrence(laura, o.id, '2030-01-01', '2030-01-10');
      const paid = await newOccurrence(laura, o.id, '2030-02-01', '2030-02-10');
      await h
        .as(laura)
        .post(`/obligations/${o.id}/occurrences/${paid.id}/confirm`, { result: 'paid' })
        .expect(200);
      const before = await occurrenceSnapshot(o.id);

      const res = await h
        .as(laura)
        .post(`/obligations/${o.id}/archive`)
        .expect(200);
      expect(res.body).toMatchObject({
        id: o.id,
        status: 'archived',
        pendingOccurrences: 1,
        providerName: o.providerName,
      });
      expect(await occurrenceSnapshot(o.id)).toEqual(before);
      expect(
        (await occurrenceSnapshot(o.id)).find((r) => r.id === pending.id),
      ).toMatchObject({ status: 'pending', amount: '75000.00' });
      expect(await statusOf(o.id)).toBe('archived');
      expect(await auditCount('obligation.archive', o.id)).toBe(1);
      // No hay borrado físico.
      expect(
        await countRows(`SELECT count(*) AS n FROM obligations WHERE id = $1`, [o.id]),
      ).toBe(1);
    });

    it('pending periods of an archived obligation can still be confirmed (debt is never hidden), but no new periods can be created', async () => {
      const o = await newObligation(laura);
      const pending = await newOccurrence(laura, o.id, '2030-06-01', '2030-06-10');
      await h.as(laura).post(`/obligations/${o.id}/archive`).expect(200);
      await h
        .as(laura)
        .post(`/obligations/${o.id}/occurrences`, {
          periodStart: '2030-07-01',
          periodEnd: '2030-07-28',
          dueDate: '2030-07-10',
          amount: '75000.00',
        })
        .expect(409);
      await h
        .as(laura)
        .post(`/obligations/${o.id}/occurrences/${pending.id}/confirm`, { result: 'paid' })
        .expect(200);
      expect(
        (await occurrenceSnapshot(o.id)).find((r) => r.id === pending.id),
      ).toMatchObject({ status: 'paid' });
    });

    it('rejects archiving twice (409) without a second audit event', async () => {
      const o = await newObligation(laura);
      await h.as(laura).post(`/obligations/${o.id}/archive`).expect(200);
      const again = await h
        .as(laura)
        .post(`/obligations/${o.id}/archive`)
        .expect(409);
      expect(again.body.message).toMatch(/ya estaba archivada/);
      expect(await auditCount('obligation.archive', o.id)).toBe(1);
    });

    it('double click: concurrent requests archive once', async () => {
      const o = await newObligation(laura);
      const results = await Promise.all([
        h.as(laura).post(`/obligations/${o.id}/archive`),
        h.as(laura).post(`/obligations/${o.id}/archive`),
        h.as(laura).post(`/obligations/${o.id}/archive`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await auditCount('obligation.archive', o.id)).toBe(1);
    });

    it('404 for unknown and for another owner, which stays untouched', async () => {
      const theirs = await newObligation(andres);
      await h.as(laura).post(`/obligations/${randomUUID()}/archive`).expect(404);
      await h.as(laura).post(`/obligations/${theirs.id}/archive`).expect(404);
      expect(
        (await h.as(andres).get(`/obligations/${theirs.id}`).expect(200)).body
          .status,
      ).toBe('active');
    });

    it('stops generating periods: the recurrence sweep skips it', async () => {
      const o = await newObligation(laura, {
        autoGenerate: true,
        startsOn: '2026-01-01',
      });
      await h
        .asService()
        .post('/internal/recurrence/generate', { workerId: 'qa' })
        .expect(200);
      const generated = (await occurrenceSnapshot(o.id)).length;
      expect(generated).toBeGreaterThan(0);
      await h.as(laura).post(`/obligations/${o.id}/archive`).expect(200);
      await h
        .asService()
        .post('/internal/recurrence/generate', { workerId: 'qa' })
        .expect(200);
      expect((await occurrenceSnapshot(o.id)).length).toBe(generated);
    });

    it('PATCH status=archived uses the same rule; mixing fields is rejected; archived is final', async () => {
      const a = await newObligation(laura);
      await h
        .as(laura)
        .patch(`/obligations/${a.id}`, { status: 'archived', concept: 'Otro' })
        .expect(400);
      expect(await statusOf(a.id)).toBe('active');
      await h.as(laura).patch(`/obligations/${a.id}`, { status: 'archived' }).expect(200);
      expect(await statusOf(a.id)).toBe('archived');
      expect(await auditCount('obligation.archive', a.id)).toBe(1);
      await h.as(laura).patch(`/obligations/${a.id}`, { concept: 'Nuevo' }).expect(409);
      await h.as(laura).patch(`/obligations/${a.id}`, { status: 'archived' }).expect(409);
    });

    it('requires authentication', async () => {
      const o = await newObligation(laura);
      const { default: request } = await import('supertest');
      await request(h.app.getHttpServer())
        .post(`/api/v1/obligations/${o.id}/archive`)
        .expect(401);
    });
  });

  describe('assistant resolve (AI intent)', () => {
    it('one clear match → applicable archive proposal with pending warning', async () => {
      const o = await newObligation(laura, {
        providerName: 'Internet Hogar de Prueba',
        concept: 'Servicio de internet',
      });
      await newOccurrence(laura, o.id, '2030-03-01', '2030-03-10');
      const job = await sendAndClaim(laura);
      const r = (
        await resolve(job, archiveExtraction({ providerName: 'Internet Hogar de Prueba' })).expect(200)
      ).body;
      expect(r.outcome).toBe('applicable');
      expect(r.proposedData).toEqual({
        action: 'archive_obligation',
        data: {
          obligationId: o.id,
          expected: {
            providerName: 'Internet Hogar de Prueba',
            concept: 'Servicio de internet',
          },
        },
      });
      expect(r.warnings.join(' ')).toMatch(/1 período pendiente/);
      expect(r.summary).toMatch(/Archivar la obligación de Internet Hogar de Prueba/);
      // resolve es solo lectura
      expect(await statusOf(o.id)).toBe('active');
    });

    it('several matches → needs_choice with provider, concept and amount; never picks one', async () => {
      const claro = await newObligation(laura, {
        providerName: 'Claro Hogar',
        concept: 'Internet Claro Hogar',
        expectedAmount: '89900.00',
      });
      const movistar = await newObligation(laura, {
        providerName: 'Movistar',
        concept: 'Internet Movistar',
        expectedAmount: '75000.00',
      });
      const job = await sendAndClaim(laura);
      const r = (
        await resolve(job, archiveExtraction({ category: 'internet' })).expect(200)
      ).body;
      expect(r.outcome).toBe('needs_choice');
      expect(r.continuation).toEqual({ intent: 'archive_obligation' });
      expect(r.proposedData).toBeNull();
      const byKey = Object.fromEntries(
        r.choices.map((c: { key: string; label: string }) => [c.key, c.label]),
      );
      expect(Object.keys(byKey).sort()).toEqual([claro.id, movistar.id].sort());
      expect(byKey[claro.id]).toMatch(/Claro Hogar.*Internet Claro Hogar.*\$89\.900/);
      expect(byKey[movistar.id]).toMatch(/Movistar.*\$75\.000/);
      expect(await statusOf(claro.id)).toBe('active');
      expect(await statusOf(movistar.id)).toBe('active');
    });

    it('no match → needs_completion; nothing identifiable → needs_completion', async () => {
      await newObligation(laura);
      const job = await sendAndClaim(laura);
      const none = (
        await resolve(job, archiveExtraction({ providerName: 'Inexistente S.A.' })).expect(200)
      ).body;
      expect(none.outcome).toBe('needs_completion');
      const vague = (await resolve(job, archiveExtraction()).expect(200)).body;
      expect(vague.outcome).toBe('needs_completion');
      expect(vague.missing).toContain('obligationId');
    });

    it('already archived → informational, never a proposal', async () => {
      const o = await newObligation(laura, { providerName: 'Telefonía Vieja' });
      await h.as(laura).post(`/obligations/${o.id}/archive`).expect(200);
      const job = await sendAndClaim(laura);
      const r = (
        await resolve(job, archiveExtraction({ providerName: 'Telefonía Vieja' })).expect(200)
      ).body;
      expect(r.outcome).toBe('informational');
      expect(r.proposedData).toBeNull();
      expect(r.summary).toMatch(/ya estaba archivada/);
    });

    it("never matches another user's obligation", async () => {
      await newObligation(andres, { providerName: 'Proveedor Ajeno Único' });
      const job = await sendAndClaim(laura);
      const r = (
        await resolve(job, archiveExtraction({ providerName: 'Proveedor Ajeno Único' })).expect(200)
      ).body;
      expect(r.outcome).toBe('needs_completion');
    });

    it('instructions inside the message are never turned into a proposal', async () => {
      await newObligation(laura, { providerName: 'Inyectable' });
      const job = await sendAndClaim(laura);
      const r = (
        await resolve(
          job,
          archiveExtraction({ providerName: 'Inyectable', containsInstructions: true }),
        ).expect(200)
      ).body;
      expect(r.outcome).toBe('unsupported');
    });
  });

  describe('AI + HITL: approve then apply', () => {
    it('does nothing until approved AND applied; then archives once with a full audit trail', async () => {
      const o = await newObligation(laura, { providerName: 'Claro Único' });
      const pendingOcc = await newOccurrence(laura, o.id, '2030-04-01', '2030-04-10');
      const before = await occurrenceSnapshot(o.id);
      const { caseId, proposal, review } = await proposeArchive(
        laura,
        archiveExtraction({ providerName: 'Claro Único' }),
      );

      // Sin aprobación: no se puede aplicar y no cambia nada.
      await apply(laura, caseId, proposal.id).expect(409);
      expect(await statusOf(o.id)).toBe('active');

      await decide(laura, review.id, { decision: 'approved' }).expect(200);
      expect(await statusOf(o.id)).toBe('active'); // aprobar ≠ aplicar

      const applied = await apply(laura, caseId, proposal.id).expect(201);
      expect(applied.body).toMatchObject({ action: 'archive_obligation' });
      expect(await statusOf(o.id)).toBe('archived');
      expect(await occurrenceSnapshot(o.id)).toEqual(before);
      expect(
        (await occurrenceSnapshot(o.id)).find((r) => r.id === pendingOcc.id),
      ).toMatchObject({ status: 'pending' });

      // Repetir: devuelve la misma aplicación sin archivar de nuevo.
      await apply(laura, caseId, proposal.id).expect(200);
      expect(
        await countRows(
          `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
          [proposal.id],
        ),
      ).toBe(1);
      expect(await auditCount('obligation.archive', o.id)).toBe(1);
      expect(
        await countRows(
          `SELECT count(*) AS n FROM audit_events WHERE action = 'case_proposal.apply' AND result = 'success' AND metadata->>'resourceId' = $1`,
          [proposal.id],
        ),
      ).toBe(1);
      const meta = (
        await sql<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM audit_events WHERE action = 'obligation.archive' AND metadata->>'resourceId' = $1`,
          [o.id],
        )
      )[0]!.metadata;
      expect(JSON.stringify(meta)).toContain('proposal');
    });

    it('a rejected proposal never archives', async () => {
      const o = await newObligation(laura, { providerName: 'Rechazable' });
      const { caseId, proposal, review } = await proposeArchive(
        laura,
        archiveExtraction({ providerName: 'Rechazable' }),
      );
      await decide(laura, review.id, { decision: 'rejected' }).expect(200);
      await apply(laura, caseId, proposal.id).expect(409);
      expect(await statusOf(o.id)).toBe('active');
    });

    it('stale proposal: archived manually after approval → 409, no second change', async () => {
      const o = await newObligation(laura, { providerName: 'Carrera Manual' });
      const { caseId, proposal, review } = await proposeArchive(
        laura,
        archiveExtraction({ providerName: 'Carrera Manual' }),
      );
      await decide(laura, review.id, { decision: 'approved' }).expect(200);
      await h.as(laura).post(`/obligations/${o.id}/archive`).expect(200);
      const res = await apply(laura, caseId, proposal.id).expect(409);
      expect(res.body.message).toMatch(/ya estaba archivada/);
      expect(await auditCount('obligation.archive', o.id)).toBe(1);
      expect(
        await countRows(
          `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
          [proposal.id],
        ),
      ).toBe(0);
    });

    it('stale proposal: obligation renamed after approval → 409 and still active', async () => {
      const o = await newObligation(laura, { providerName: 'Nombre Original' });
      const { caseId, proposal, review } = await proposeArchive(
        laura,
        archiveExtraction({ providerName: 'Nombre Original' }),
      );
      await decide(laura, review.id, { decision: 'approved' }).expect(200);
      await h
        .as(laura)
        .patch(`/obligations/${o.id}`, { providerName: 'Nombre Cambiado' })
        .expect(200);
      await apply(laura, caseId, proposal.id).expect(409);
      expect(await statusOf(o.id)).toBe('active');
    });

    it("another user cannot apply or decide on my proposal", async () => {
      const o = await newObligation(laura, { providerName: 'Solo Mía' });
      const { caseId, proposal, review } = await proposeArchive(
        laura,
        archiveExtraction({ providerName: 'Solo Mía' }),
      );
      await decide(andres, review.id, { decision: 'approved' }).expect(404);
      await decide(laura, review.id, { decision: 'approved' }).expect(200);
      await apply(andres, caseId, proposal.id).expect(404);
      expect(await statusOf(o.id)).toBe('active');
    });

    it('archive proposals cannot be forged to touch another owner (obligationId of someone else)', async () => {
      const theirs = await newObligation(andres, { providerName: 'De Andrés' });
      const job = await sendAndClaim(laura);
      const p = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/proposals`, {
            ...ref(job),
            source: 'llm',
            proposedData: {
              action: 'archive_obligation',
              data: {
                obligationId: theirs.id,
                expected: { providerName: 'De Andrés', concept: theirs.concept },
              },
            },
          })
          .expect(201)
      ).body;
      const rev = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/hitl-requests`, {
            ...ref(job),
            decisionType: 'data_confirmation',
            proposalId: p.id,
            options: { summary: 'x' },
          })
          .expect(201)
      ).body;
      await decide(laura, rev.id, { decision: 'approved' }).expect(200);
      await apply(laura, job.case.id, p.id).expect(404);
      expect(
        (await h.as(andres).get(`/obligations/${theirs.id}`).expect(200)).body.status,
      ).toBe('active');
    });

  });

  describe('AI + HITL: disambiguation with continuation (A-7)', () => {
    const twoInternet = async (user: TestUser) => {
      const claro = await newObligation(user, {
        providerName: 'Claro Hogar',
        concept: 'Internet Claro Hogar',
        expectedAmount: '89900.00',
      });
      const movistar = await newObligation(user, {
        providerName: 'Movistar',
        concept: 'Internet Movistar',
        expectedAmount: '75000.00',
      });
      return { claro, movistar };
    };

    /** Como n8n con needs_choice: propuesta no aplicable + revisión con alternativas. */
    const choiceReview = async (
      user: TestUser,
      choices?: { key: string; label: string }[],
    ) => {
      const job = await sendAndClaim(user);
      const r = (
        await resolve(job, archiveExtraction({ category: 'internet' })).expect(200)
      ).body;
      expect(r.outcome).toBe('needs_choice');
      const p = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/proposals`, {
            ...ref(job),
            source: 'llm',
            proposedData: { resultado: 'needs_choice', requiereRevisionManual: true },
          })
          .expect(201)
      ).body;
      const rev = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/hitl-requests`, {
            ...ref(job),
            decisionType: 'conflict_resolution',
            proposalId: p.id,
            options: {
              summary: r.summary,
              choices: choices ?? r.choices,
              context: { kind: 'target_selection', continuation: r.continuation },
            },
          })
          .expect(201)
      ).body;
      return { job, caseId: job.case.id, choice: rev, resolved: r };
    };

    it('full path: choose → archive proposal → approve → apply; the other obligation stays intact', async () => {
      const { claro, movistar } = await twoInternet(laura);
      const movOcc = await newOccurrence(laura, movistar.id, '2030-05-01', '2030-05-10');
      const movBefore = await occurrenceSnapshot(movistar.id);
      const { caseId, choice } = await choiceReview(laura);

      const decided = (
        await decide(laura, choice.id, { decision: 'approved', choice: claro.id }).expect(200)
      ).body;
      // Elegir NO archiva nada.
      expect(await statusOf(claro.id)).toBe('active');
      expect(await statusOf(movistar.id)).toBe('active');
      const followUpId = decided.decision.followUpRequestId as string;
      expect(followUpId).toBeTruthy();

      const follow = (await h.as(laura).get(`/hitl-requests/${followUpId}`).expect(200)).body;
      expect(follow).toMatchObject({
        status: 'pending',
        decisionType: 'data_confirmation',
      });
      expect(follow.proposal.proposedData).toEqual({
        action: 'archive_obligation',
        data: {
          obligationId: claro.id,
          expected: { providerName: 'Claro Hogar', concept: 'Internet Claro Hogar' },
        },
      });
      // El caso sigue abierto esperando la segunda revisión.
      expect(
        (await h.as(laura).get(`/cases/${caseId}`).expect(200)).body.status,
      ).toBe('awaiting_human');

      await decide(laura, followUpId, { decision: 'approved' }).expect(200);
      expect(await statusOf(claro.id)).toBe('active'); // aprobar ≠ aplicar
      await apply(laura, caseId, follow.proposal.id).expect(201);

      expect(await statusOf(claro.id)).toBe('archived');
      expect(await statusOf(movistar.id)).toBe('active');
      expect(await occurrenceSnapshot(movistar.id)).toEqual(movBefore);
      expect(
        (await occurrenceSnapshot(movistar.id)).find((r) => r.id === movOcc.id),
      ).toMatchObject({ status: 'pending' });
      expect(await auditCount('obligation.archive', claro.id)).toBe(1);
      expect(await auditCount('obligation.archive', movistar.id)).toBe(0);
    });

    it('repeating the same choice does not create a second proposal or review', async () => {
      const { claro } = await twoInternet(laura);
      const { caseId, choice } = await choiceReview(laura);
      const first = (
        await decide(laura, choice.id, { decision: 'approved', choice: claro.id }).expect(200)
      ).body;
      const again = (
        await decide(laura, choice.id, { decision: 'approved', choice: claro.id }).expect(200)
      ).body;
      expect(again.decision.followUpRequestId).toBe(first.decision.followUpRequestId);
      expect(
        await countRows(
          `SELECT count(*) AS n FROM hitl_requests WHERE case_id = $1 AND decision_type = 'data_confirmation'`,
          [caseId],
        ),
      ).toBe(1);
      // Otra alternativa distinta ya no puede decidirse (409).
      await decide(laura, choice.id, { decision: 'approved', choice: randomUUID() }).expect(409);
    });

    it('rejecting the choice archives nothing and creates nothing', async () => {
      const { claro, movistar } = await twoInternet(laura);
      const { caseId, choice } = await choiceReview(laura);
      await decide(laura, choice.id, { decision: 'rejected' }).expect(200);
      expect(await statusOf(claro.id)).toBe('active');
      expect(await statusOf(movistar.id)).toBe('active');
      expect(
        await countRows(
          `SELECT count(*) AS n FROM hitl_requests WHERE case_id = $1 AND decision_type = 'data_confirmation'`,
          [caseId],
        ),
      ).toBe(0);
    });

    it('tampered selection: a key that was not offered is rejected (400)', async () => {
      const { claro } = await twoInternet(laura);
      const other = await newObligation(laura, { providerName: 'No Ofrecida', category: 'gas' });
      const { choice } = await choiceReview(laura);
      await decide(laura, choice.id, { decision: 'approved', choice: other.id }).expect(400);
      await decide(laura, choice.id, { decision: 'approved', choice: 'cualquiera' }).expect(400);
      expect(await statusOf(other.id)).toBe('active');
      expect(await statusOf(claro.id)).toBe('active');
    });

    it("tampered choices: an offered key that belongs to ANOTHER user is refused (409) and untouched", async () => {
      const { claro } = await twoInternet(laura);
      const theirs = await newObligation(andres, { providerName: 'Ajena Internet' });
      const { choice } = await choiceReview(laura, [
        { key: claro.id, label: 'Claro' },
        { key: theirs.id, label: 'Ajena' },
      ]);
      const res = await decide(laura, choice.id, {
        decision: 'approved',
        choice: theirs.id,
      }).expect(409);
      expect(res.body.message).toMatch(/ya no está disponible/);
      expect(
        (await h.as(andres).get(`/obligations/${theirs.id}`).expect(200)).body.status,
      ).toBe('active');
      // La revisión sigue pendiente: nada se registró.
      expect(
        (await h.as(laura).get(`/hitl-requests/${choice.id}`).expect(200)).body.status,
      ).toBe('pending');
    });

    it('stale alternative: archived between listing and choosing → 409, nothing recorded', async () => {
      const { claro } = await twoInternet(laura);
      const { choice } = await choiceReview(laura);
      await h.as(laura).post(`/obligations/${claro.id}/archive`).expect(200);
      await decide(laura, choice.id, { decision: 'approved', choice: claro.id }).expect(409);
      expect(
        (await h.as(laura).get(`/hitl-requests/${choice.id}`).expect(200)).body.status,
      ).toBe('pending');
    });

    it('state change between selection and application: archived manually → apply 409', async () => {
      const { claro } = await twoInternet(laura);
      const { caseId, choice } = await choiceReview(laura);
      const decided = (
        await decide(laura, choice.id, { decision: 'approved', choice: claro.id }).expect(200)
      ).body;
      const fid = decided.decision.followUpRequestId as string;
      const follow = (await h.as(laura).get(`/hitl-requests/${fid}`).expect(200)).body;
      await decide(laura, fid, { decision: 'approved' }).expect(200);
      await h.as(laura).post(`/obligations/${claro.id}/archive`).expect(200);
      await apply(laura, caseId, follow.proposal.id).expect(409);
      expect(await auditCount('obligation.archive', claro.id)).toBe(1);
    });

    it('MODIFY: ambiguous "cambia el vencimiento del internet al día 20" → choose → approve → apply changes ONLY the chosen one', async () => {
      const { claro, movistar } = await twoInternet(laura);
      const job = await sendAndClaim(laura);
      const r = (
        await resolve(job, {
          intent: 'update_obligation_schedule',
          category: 'internet',
          dueDay: 20,
        }).expect(200)
      ).body;
      expect(r.outcome).toBe('needs_choice');
      expect(r.continuation).toEqual({
        intent: 'update_obligation_schedule',
        params: { dueDay: 20 },
      });
      expect(r.choices).toHaveLength(2);
      expect(r.summary).toMatch(/modificar/);
      const p = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/proposals`, {
            ...ref(job),
            source: 'llm',
            proposedData: { resultado: 'needs_choice', requiereRevisionManual: true },
          })
          .expect(201)
      ).body;
      const rev = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/hitl-requests`, {
            ...ref(job),
            decisionType: 'conflict_resolution',
            proposalId: p.id,
            options: {
              summary: r.summary,
              choices: r.choices,
              context: { kind: 'target_selection', continuation: r.continuation },
            },
          })
          .expect(201)
      ).body;
      const decided = (
        await decide(laura, rev.id, { decision: 'approved', choice: movistar.id }).expect(200)
      ).body;
      const fid = decided.decision.followUpRequestId as string;
      const follow = (await h.as(laura).get(`/hitl-requests/${fid}`).expect(200)).body;
      expect(follow.proposal.proposedData).toEqual({
        action: 'update_obligation_schedule',
        data: {
          obligationId: movistar.id,
          expected: { dueDay: 10 },
          changes: { dueDay: 20 },
        },
      });
      // Nada cambió aún.
      expect(
        (await h.as(laura).get(`/obligations/${movistar.id}`).expect(200)).body.dueDay,
      ).toBe(10);
      await decide(laura, fid, { decision: 'approved' }).expect(200);
      expect(
        (await h.as(laura).get(`/obligations/${movistar.id}`).expect(200)).body.dueDay,
      ).toBe(10);
      await apply(laura, job.case.id, follow.proposal.id).expect(201);
      expect(
        (await h.as(laura).get(`/obligations/${movistar.id}`).expect(200)).body.dueDay,
      ).toBe(20);
      expect(
        (await h.as(laura).get(`/obligations/${claro.id}`).expect(200)).body.dueDay,
      ).toBe(10);
      expect(await auditCount('obligation.update', movistar.id)).toBe(1);
      expect(await auditCount('obligation.update', claro.id)).toBe(0);
    });

    it('MODIFY: obligation changed between selection and application → 409, nothing overwritten', async () => {
      const { movistar } = await twoInternet(laura);
      const job = await sendAndClaim(laura);
      const r = (
        await resolve(job, {
          intent: 'update_obligation_schedule',
          category: 'internet',
          dueDay: 20,
        }).expect(200)
      ).body;
      const p = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/proposals`, {
            ...ref(job),
            source: 'llm',
            proposedData: { resultado: 'needs_choice', requiereRevisionManual: true },
          })
          .expect(201)
      ).body;
      const rev = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/hitl-requests`, {
            ...ref(job),
            decisionType: 'conflict_resolution',
            proposalId: p.id,
            options: {
              summary: r.summary,
              choices: r.choices,
              context: { kind: 'target_selection', continuation: r.continuation },
            },
          })
          .expect(201)
      ).body;
      const decided = (
        await decide(laura, rev.id, { decision: 'approved', choice: movistar.id }).expect(200)
      ).body;
      const fid = decided.decision.followUpRequestId as string;
      const follow = (await h.as(laura).get(`/hitl-requests/${fid}`).expect(200)).body;
      await decide(laura, fid, { decision: 'approved' }).expect(200);
      await h.as(laura).patch(`/obligations/${movistar.id}`, { dueDay: 12 }).expect(200);
      await apply(laura, job.case.id, follow.proposal.id).expect(409);
      expect(
        (await h.as(laura).get(`/obligations/${movistar.id}`).expect(200)).body.dueDay,
      ).toBe(12);
    });

    it('MODIFY without ambiguity: a single match proposes directly (no extra step)', async () => {
      const o = await newObligation(laura, { providerName: 'Proveedor Único Mod', category: 'gas' });
      const job = await sendAndClaim(laura);
      const r = (
        await resolve(job, {
          intent: 'update_obligation_schedule',
          providerName: 'Proveedor Único Mod',
          dueDay: 22,
        }).expect(200)
      ).body;
      expect(r.outcome).toBe('applicable');
      expect(r.continuation).toBeUndefined();
      expect(r.proposedData.data).toMatchObject({
        obligationId: o.id,
        changes: { dueDay: 22 },
      });
    });

    it('a choice review WITHOUT the continuation marker keeps the old behaviour (records only)', async () => {
      const { claro } = await twoInternet(laura);
      const job = await sendAndClaim(laura);
      const p = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/proposals`, {
            ...ref(job),
            source: 'llm',
            proposedData: { resultado: 'needs_choice', requiereRevisionManual: true },
          })
          .expect(201)
      ).body;
      const rev = (
        await h
          .asService()
          .post(`/internal/cases/${job.case.id}/hitl-requests`, {
            ...ref(job),
            decisionType: 'conflict_resolution',
            proposalId: p.id,
            options: {
              summary: 'x',
              choices: [{ key: claro.id, label: 'Claro' }],
              context: { kind: 'target_selection' },
            },
          })
          .expect(201)
      ).body;
      const res = (
        await decide(laura, rev.id, { decision: 'approved', choice: claro.id }).expect(200)
      ).body;
      expect(res.decision.followUpRequestId).toBeUndefined();
      expect(await statusOf(claro.id)).toBe('active');
    });
  });

  // Al final: una propuesta con campos/acciones prohibidas activa el kill switch (esperado).
  describe('forged proposals (activates the kill switch)', () => {
    it('extra fields (status, ownerId) or unknown actions are refused', async () => {
      const o = await newObligation(laura);
      const job = await sendAndClaim(laura);
      await h
        .asService()
        .post(`/internal/cases/${job.case.id}/proposals`, {
          ...ref(job),
          source: 'llm',
          proposedData: {
            action: 'archive_obligation',
            data: { obligationId: o.id, expected: { providerName: 'a', concept: 'b' }, status: 'archived' },
          },
        })
        .expect(422);
      await h
        .asService()
        .post(`/internal/cases/${job.case.id}/proposals`, {
          ...ref(job),
          source: 'llm',
          proposedData: { action: 'delete_obligation', data: { obligationId: o.id } },
        })
        .expect(422);
    });
  });
});
