import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AuditService } from '../src/audit/audit.service.js';
import { createTestClock, type TestClock, withClock } from './support/clock.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Alertas internas: evaluación determinística (token de servicio), consulta,
 * lectura y descarte (JWT), deduplicación, resolución y aislamiento entre
 * propietarios. La evaluación nunca modifica períodos, cobros ni contratos.
 */
describe('Alerts (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let clock: TestClock;
  let laura: TestUser;
  let andres: TestUser;
  let camila: TestUser;
  let daniel: TestUser;

  const ids = {} as Record<string, string>;

  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => (await t.client.query<T>(query, params)).rows;

  const count = async (query: string, params: unknown[] = []) =>
    Number((await sql<{ n: string }>(query, params))[0]!.n);

  const evaluate = (client = () => h.asService(), body: object = {}) =>
    client().post('/internal/alerts/evaluate', {
      workerId: 'n8n-scheduler',
      ...body,
    });

  const activeAlerts = (resourceId: string) =>
    sql<{ id: string; type: string; relevant_date: string; dedup_key: string }>(
      `SELECT id, type, relevant_date::text, dedup_key FROM alerts
        WHERE state = 'active' AND $1::uuid IN (occurrence_id, rent_charge_id, contract_id, hitl_request_id)`,
      [resourceId],
    );

  const alertFor = async (resourceId: string) => {
    const [row] = await activeAlerts(resourceId);
    expect(row, `alerta activa para ${resourceId}`).toBeDefined();
    return row!;
  };

  const snapshot = () =>
    sql(
      `SELECT (SELECT count(*) FROM alerts) AS alerts,
              (SELECT count(*) FROM audit_events) AS audit,
              (SELECT string_agg(id::text || status::text || due_date::text, ',' ORDER BY id) FROM obligation_occurrences) AS occ,
              (SELECT string_agg(id::text || status::text || due_date::text, ',' ORDER BY id) FROM rent_charges) AS charges,
              (SELECT string_agg(id::text || status::text || ends_on::text, ',' ORDER BY id) FROM contracts) AS contracts`,
    );

  beforeAll(async () => {
    t = await createMigratedDatabase();
    const pw = () => randomBytes(12).toString('base64url');
    [laura, andres, camila, daniel] = await Promise.all(
      ['laura', 'andres', 'camila', 'daniel'].map((name) =>
        createTestUser(t.db, {
          email: `${name}@alerts.test`,
          password: pw(),
          displayName: name,
        }),
      ),
    );
    clock = createTestClock();
    h = await createTestApp(t.db, withClock(clock));
    const d = clock.d;

    // Laura: obligación con períodos en distintas situaciones.
    const obligation = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Empresa de energía',
          concept: 'Energía',
          category: 'electricity',
          expectedAmount: '145000.00',
          reminderDaysBefore: 3,
        })
        .expect(201)
    ).body.id as string;
    ids.obligation = obligation;
    const occurrence = async (key: string, due: string) => {
      ids[key] = (
        await h
          .as(laura)
          .post(`/obligations/${obligation}/occurrences`, {
            periodStart: due,
            periodEnd: due,
            dueDate: due,
          })
          .expect(201)
      ).body.id;
    };
    await occurrence('occSoon', d(3));
    await occurrence('occToday', d(0));
    await occurrence('occOverdue', d(-2));
    await occurrence('occFar', d(20));
    await occurrence('occPaid', d(-5));
    await occurrence('occCancelled', d(1));
    await h
      .as(laura)
      .post(`/obligations/${obligation}/occurrences/${ids.occPaid}/confirm`, {
        result: 'paid',
      })
      .expect(200);
    await h
      .as(laura)
      .patch(`/obligations/${obligation}/occurrences/${ids.occCancelled}`, {
        status: 'cancelled',
      })
      .expect(200);

    // Andrés: cobros de arriendo.
    const andresProperty = (
      await h.as(andres).post('/properties', { name: 'Apto' }).expect(201)
    ).body.id as string;
    const rental = (
      await h
        .as(andres)
        .post('/rentals', {
          propertyId: andresProperty,
          expectedAmount: '1200000.00',
          dueDay: 5,
          startsOn: '2025-01-01',
        })
        .expect(201)
    ).body.id as string;
    ids.rental = rental;
    const charge = async (key: string, due: string) => {
      ids[key] = (
        await h
          .as(andres)
          .post(`/rentals/${rental}/charges`, {
            periodStart: due,
            periodEnd: due,
            dueDate: due,
          })
          .expect(201)
      ).body.id;
    };
    await charge('chargeSoon', d(2));
    await charge('chargeOverdue', d(-3));
    await charge('chargeFar', d(30));
    await charge('chargeReceived', d(-10));
    await h
      .as(andres)
      .post(`/rentals/${rental}/charges/${ids.chargeReceived}/confirm`, {
        evidence: 'Transferencia 123',
      })
      .expect(200);

    // Camila: contratos.
    const camilaProperty = (
      await h.as(camila).post('/properties', { name: 'Casa' }).expect(201)
    ).body.id as string;
    const contract = async (key: string, endsOn: string) => {
      ids[key] = (
        await h
          .as(camila)
          .post('/contracts', {
            propertyId: camilaProperty,
            startsOn: '2025-01-01',
            endsOn,
          })
          .expect(201)
      ).body.id;
    };
    await contract('contractSoon', d(10));
    await contract('contractPassed', d(-1));
    await contract('contractTerminated', d(5));
    await contract('contractFar', d(200));
    await h
      .as(camila)
      .patch(`/contracts/${ids.contractTerminated}`, { status: 'terminated' })
      .expect(200);

    // Laura: una revisión humana pendiente (plazo de 24 h).
    const c = (
      await h
        .as(laura)
        .post('/cases', { type: 'household_obligation' })
        .expect(201)
    ).body;
    ids.case = c.id;
    const [job] = (
      await h
        .asService()
        .post('/internal/workflow-jobs/claim', { workerId: 'w1' })
        .expect(200)
    ).body.jobs;
    ids.hitl = (
      await h
        .asService()
        .post(`/internal/cases/${c.id}/hitl-requests`, {
          jobId: job.id,
          claimToken: job.claimToken,
          decisionType: 'other',
          options: { summary: 'Confirma el proveedor' },
        })
        .expect(201)
    ).body.id;
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
  });

  describe('internal evaluation endpoint', () => {
    it('requires the service token and rejects user JWTs', async () => {
      await request(h.app.getHttpServer())
        .post('/api/v1/internal/alerts/evaluate')
        .send({ workerId: 'n8n-scheduler' })
        .expect(401);
      await evaluate(() => h.as(laura)).expect(401);
      await evaluate(() => h.as(daniel)).expect(401);
    });

    it('does not let a service token read user alerts', async () => {
      await h.asService().get('/alerts').expect(401);
      await h.asService().get('/attention').expect(401);
      await h.asService().get('/dashboard/summary').expect(401);
    });

    it('rejects unknown fields (no SQL, owner or date injection)', async () => {
      await evaluate(undefined, { ownerId: laura.profileId }).expect(400);
      await evaluate(undefined, { date: '2030-01-01' }).expect(400);
      await evaluate(undefined, { where: '1=1' }).expect(400);
      await evaluate(undefined, { batchSize: 0 }).expect(400);
      await evaluate(undefined, { cursor: "x' OR 1=1" }).expect(400);
    });

    it('creates exactly the expected alerts on the first run', async () => {
      const before = await snapshot();
      const res = await evaluate().expect(200);
      expect(res.body).toMatchObject({
        evaluationDate: clock.today(),
        timeZone: 'America/Bogota',
        created: 8,
        resolved: 0,
        reactivated: 0,
        complete: true,
        nextCursor: null,
      });
      expect(res.headers['x-correlation-id']).toBe(res.body.correlationId);

      expect((await alertFor(ids.occSoon)).type).toBe('obligation_due_soon');
      expect((await alertFor(ids.occToday)).type).toBe('obligation_due_soon');
      expect((await alertFor(ids.occOverdue)).type).toBe('obligation_overdue');
      expect((await alertFor(ids.chargeSoon)).type).toBe(
        'rent_charge_due_soon',
      );
      expect((await alertFor(ids.chargeOverdue)).type).toBe(
        'rent_charge_overdue',
      );
      expect((await alertFor(ids.contractSoon)).type).toBe(
        'contract_ending_soon',
      );
      expect((await alertFor(ids.contractPassed)).type).toBe(
        'contract_end_passed',
      );
      expect((await alertFor(ids.hitl)).type).toBe('hitl_pending');
      for (const key of [
        'occFar',
        'occPaid',
        'occCancelled',
        'chargeFar',
        'chargeReceived',
        'contractTerminated',
        'contractFar',
      ]) {
        expect(await activeAlerts(ids[key]!), key).toEqual([]);
      }

      // Solo se escribieron alertas y su auditoría: el negocio quedó intacto.
      const after = await snapshot();
      expect(after[0]).toMatchObject({
        occ: before[0]!.occ,
        charges: before[0]!.charges,
        contracts: before[0]!.contracts,
      });
      expect(
        await count(
          `SELECT count(*) AS n FROM audit_events WHERE action = 'alert.create' AND correlation_id = $1 AND actor_type = 'workflow' AND actor_id = 'n8n:n8n-scheduler'`,
          [res.body.correlationId],
        ),
      ).toBe(8);
    });

    it('is idempotent: a second run for the same date changes nothing', async () => {
      const before = await snapshot();
      const res = await evaluate().expect(200);
      expect(res.body).toMatchObject({
        created: 0,
        resolved: 0,
        reactivated: 0,
        unchanged: 16,
      });
      expect(await snapshot()).toEqual(before);
    });

    it('never duplicates alerts under simultaneous evaluations', async () => {
      const due = clock.d(4);
      ids.occConcurrent = (
        await h
          .as(laura)
          .post(`/obligations/${ids.obligation}/occurrences`, {
            periodStart: due,
            periodEnd: due,
            dueDate: due,
          })
          .expect(201)
      ).body.id;
      const results = await Promise.all(
        Array.from({ length: 4 }, () => evaluate()),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(results.reduce((n, r) => n + r.body.created, 0)).toBe(1);
      expect(
        await count(
          `SELECT count(*) AS n FROM alerts WHERE occurrence_id = $1`,
          [ids.occConcurrent],
        ),
      ).toBe(1);
    });

    it('processes in bounded batches and resumes with a cursor', async () => {
      const due = clock.d(5);
      ids.occBatch = (
        await h
          .as(laura)
          .post(`/obligations/${ids.obligation}/occurrences`, {
            periodStart: due,
            periodEnd: due,
            dueDate: due,
          })
          .expect(201)
      ).body.id;
      let res = await evaluate(undefined, {
        batchSize: 1,
        maxBatches: 2,
      }).expect(200);
      expect(res.body.complete).toBe(false);
      expect(res.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      let created = res.body.created;
      let calls = 1;
      while (!res.body.complete) {
        res = await evaluate(undefined, {
          batchSize: 1,
          maxBatches: 2,
          cursor: res.body.nextCursor,
        }).expect(200);
        created += res.body.created;
        calls += 1;
        expect(calls).toBeLessThan(60);
      }
      expect(created).toBe(1);
      expect(await activeAlerts(ids.occBatch)).toHaveLength(1);
    });
  });

  describe('user alerts API', () => {
    it('lists only the authenticated user alerts', async () => {
      const lauraAlerts = (
        await h.as(laura).get('/alerts?pageSize=100').expect(200)
      ).body;
      expect(lauraAlerts.total).toBe(lauraAlerts.items.length);
      const lauraResources = new Set(
        lauraAlerts.items.map(
          (a: { resource: { id: string } }) => a.resource.id,
        ),
      );
      expect(lauraResources.has(ids.occSoon)).toBe(true);
      expect(lauraResources.has(ids.hitl)).toBe(true);
      expect(lauraResources.has(ids.chargeSoon)).toBe(false);
      expect(lauraResources.has(ids.contractSoon)).toBe(false);

      const andresAlerts = (await h.as(andres).get('/alerts').expect(200)).body;
      expect(andresAlerts.total).toBe(2);
      expect(
        andresAlerts.items.every(
          (a: { resource: { type: string } }) =>
            a.resource.type === 'rent_charge',
        ),
      ).toBe(true);
      expect(
        (await h.as(daniel).get('/alerts').expect(200)).body,
      ).toMatchObject({
        items: [],
        total: 0,
      });
    });

    it('describes each alert without duplicating financial data', async () => {
      const alert = await alertFor(ids.occOverdue);
      const body = (await h.as(laura).get(`/alerts/${alert.id}`).expect(200))
        .body;
      expect(body).toMatchObject({
        id: alert.id,
        type: 'obligation_overdue',
        severity: 'critical',
        title: 'Obligación vencida sin confirmar',
        relevantDate: clock.d(-2),
        state: 'active',
        requiresAttention: true,
        read: false,
        resource: {
          type: 'obligation_occurrence',
          id: ids.occOverdue,
          path: `/obligations/${ids.obligation}/occurrences/${ids.occOverdue}`,
        },
      });
      expect(body).not.toHaveProperty('amount');
      expect(body).not.toHaveProperty('ownerId');
      expect(body).not.toHaveProperty('dedupKey');
    });

    it('answers 404 for alerts of another owner (read, dismiss, get)', async () => {
      const alert = await alertFor(ids.chargeSoon);
      await h.as(laura).get(`/alerts/${alert.id}`).expect(404);
      await h.as(laura).post(`/alerts/${alert.id}/read`).expect(404);
      await h.as(daniel).post(`/alerts/${alert.id}/dismiss`).expect(404);
      const [row] = await sql<{ read_at: unknown; state: string }>(
        `SELECT read_at, state FROM alerts WHERE id = $1`,
        [alert.id],
      );
      expect(row).toEqual({ read_at: null, state: 'active' });
      await h.as(laura).get('/alerts/not-a-uuid').expect(400);
    });

    it('marks as read idempotently without touching the resource', async () => {
      const alert = await alertFor(ids.occSoon);
      const res = await h
        .as(laura)
        .post(`/alerts/${alert.id}/read`)
        .expect(200);
      expect(res.body).toMatchObject({ read: true, state: 'active' });
      await h.as(laura).post(`/alerts/${alert.id}/read`).expect(200);
      expect(
        await count(
          `SELECT count(*) AS n FROM audit_events WHERE action = 'alert.read' AND metadata->>'resourceId' = $1`,
          [alert.id],
        ),
      ).toBe(1);
      const [occ] = await sql<{ status: string; confirmed_by: unknown }>(
        `SELECT status, confirmed_by FROM obligation_occurrences WHERE id = $1`,
        [ids.occSoon],
      );
      expect(occ).toEqual({ status: 'pending', confirmed_by: null });
    });

    it('filters by read state, type, severity and attention, with pagination', async () => {
      const unread = (await h.as(laura).get('/alerts?read=false&pageSize=100'))
        .body;
      expect(
        unread.items.every((a: { read: boolean }) => a.read === false),
      ).toBe(true);
      const read = (await h.as(laura).get('/alerts?read=true').expect(200))
        .body;
      expect(read.total).toBe(1);
      const overdue = (
        await h.as(laura).get('/alerts?type=obligation_overdue').expect(200)
      ).body;
      expect(
        overdue.items.map((a: { resource: { id: string } }) => a.resource.id),
      ).toEqual([ids.occOverdue]);
      const critical = (
        await h.as(laura).get('/alerts?severity=critical').expect(200)
      ).body;
      expect(critical.total).toBe(1);

      const all = (
        await h.as(laura).get('/alerts?order=asc&pageSize=100').expect(200)
      ).body;
      const pages = [];
      for (let page = 1; page <= Math.ceil(all.total / 2); page++) {
        pages.push(
          ...(
            await h.as(laura).get(`/alerts?order=asc&pageSize=2&page=${page}`)
          ).body.items,
        );
      }
      expect(pages.map((a: { id: string }) => a.id)).toEqual(
        all.items.map((a: { id: string }) => a.id),
      );
      await h.as(laura).get('/alerts?read=maybe').expect(400);
      await h.as(laura).get('/alerts?pageSize=1000').expect(400);
      await h.as(laura).get(`/alerts?ownerId=${andres.profileId}`).expect(400);
    });

    it('dismisses without altering the resource and is not recreated', async () => {
      const alert = await alertFor(ids.contractSoon);
      const res = await h
        .as(camila)
        .post(`/alerts/${alert.id}/dismiss`)
        .expect(200);
      expect(res.body).toMatchObject({
        state: 'dismissed',
        requiresAttention: false,
      });
      await h.as(camila).post(`/alerts/${alert.id}/dismiss`).expect(200);
      expect(
        await count(
          `SELECT count(*) AS n FROM audit_events WHERE action = 'alert.dismiss' AND metadata->>'resourceId' = $1`,
          [alert.id],
        ),
      ).toBe(1);
      const run = await evaluate().expect(200);
      expect(run.body.created).toBe(0);
      expect(await activeAlerts(ids.contractSoon)).toEqual([]);
      const contract = (
        await h.as(camila).get(`/contracts/${ids.contractSoon}`).expect(200)
      ).body;
      expect(contract).toMatchObject({ status: 'active', endsOn: clock.d(10) });
    });
  });

  describe('resolution and consistency', () => {
    it('stops showing an obligation alert once the user confirms payment', async () => {
      const alert = await alertFor(ids.occToday);
      await h
        .as(laura)
        .post(
          `/obligations/${ids.obligation}/occurrences/${ids.occToday}/confirm`,
          {
            result: 'paid',
            reference: 'Comprobante 77',
          },
        )
        .expect(200);
      // Inmediato y sin escribir: la consulta ya la presenta resuelta.
      const live = (await h.as(laura).get(`/alerts/${alert.id}`).expect(200))
        .body;
      expect(live).toMatchObject({
        state: 'resolved',
        requiresAttention: false,
      });
      const active = (
        await h.as(laura).get('/alerts?state=active&pageSize=100')
      ).body.items.map((a: { id: string }) => a.id);
      expect(active).not.toContain(alert.id);

      const res = await evaluate().expect(200);
      expect(res.body.resolved).toBeGreaterThanOrEqual(1);
      const [row] = await sql(
        `SELECT state, resolution_reason FROM alerts WHERE id = $1`,
        [alert.id],
      );
      expect(row).toEqual({
        state: 'resolved',
        resolution_reason: 'resource_closed',
      });
      // El historial de la confirmación humana queda intacto.
      const [occ] = await sql<{ status: string; confirmed_by: string }>(
        `SELECT status, confirmed_by FROM obligation_occurrences WHERE id = $1`,
        [ids.occToday],
      );
      expect(occ).toEqual({ status: 'paid', confirmed_by: laura.profileId });
    });

    it('resolves a rent alert once the owner confirms the income', async () => {
      const alert = await alertFor(ids.chargeOverdue);
      await h
        .as(andres)
        .post(`/rentals/${ids.rental}/charges/${ids.chargeOverdue}/confirm`, {
          evidence: 'Transferencia 456',
        })
        .expect(200);
      expect(
        (await h.as(andres).get(`/alerts/${alert.id}`).expect(200)).body.state,
      ).toBe('resolved');
      await evaluate().expect(200);
      const [row] = await sql(
        `SELECT state, resolution_reason FROM alerts WHERE id = $1`,
        [alert.id],
      );
      expect(row).toEqual({
        state: 'resolved',
        resolution_reason: 'resource_closed',
      });
    });

    it('keeps a single consistent alert when the due date changes', async () => {
      const old = await alertFor(ids.occSoon);
      await h
        .as(laura)
        .patch(`/obligations/${ids.obligation}/occurrences/${ids.occSoon}`, {
          dueDate: clock.d(6),
        })
        .expect(200);
      expect(
        (await h.as(laura).get(`/alerts/${old.id}`).expect(200)).body.state,
      ).toBe('resolved');

      const res = await evaluate().expect(200);
      expect(res.body.created).toBe(1);
      const active = await activeAlerts(ids.occSoon);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        type: 'obligation_due_soon',
        relevant_date: clock.d(6),
      });
      const [previous] = await sql(
        `SELECT state, resolution_reason FROM alerts WHERE id = $1`,
        [old.id],
      );
      expect(previous).toEqual({
        state: 'resolved',
        resolution_reason: 'superseded',
      });

      // Volver a la fecha original reactiva la alerta anterior, sin duplicar.
      await h
        .as(laura)
        .patch(`/obligations/${ids.obligation}/occurrences/${ids.occSoon}`, {
          dueDate: clock.d(3),
        })
        .expect(200);
      const back = await evaluate().expect(200);
      expect(back.body).toMatchObject({ created: 0, reactivated: 1 });
      expect((await alertFor(ids.occSoon)).id).toBe(old.id);
      expect(
        await count(
          `SELECT count(*) AS n FROM alerts WHERE occurrence_id = $1`,
          [ids.occSoon],
        ),
      ).toBe(2);
    });

    it('resolves a review alert once the user decides', async () => {
      const alert = await alertFor(ids.hitl);
      await h
        .as(laura)
        .post(`/hitl-requests/${ids.hitl}/decision`, { decision: 'rejected' })
        .expect(200);
      expect(
        (await h.as(laura).get(`/alerts/${alert.id}`).expect(200)).body.state,
      ).toBe('resolved');
      await evaluate().expect(200);
      expect(await activeAlerts(ids.hitl)).toEqual([]);
    });

    it('rolls back alerts when the audit store fails', async () => {
      const due = clock.d(2);
      const occ = (
        await h
          .as(laura)
          .post(`/obligations/${ids.obligation}/occurrences`, {
            periodStart: due,
            periodEnd: due,
            dueDate: due,
          })
          .expect(201)
      ).body.id as string;
      const reject = () =>
        Promise.reject(new Error('audit storage unavailable'));
      const failing = await createTestApp(t.db, (b) =>
        withClock(clock)(b).overrideProvider(AuditService).useValue({
          recordUserAction: reject,
          recordAutomatedAction: reject,
        }),
      );
      try {
        await evaluate(() => failing.asService()).expect(500);
        expect(await activeAlerts(occ)).toEqual([]);
        await failing
          .as(laura)
          .post(`/alerts/${(await alertFor(ids.occOverdue)).id}/read`)
          .expect(500);
        expect(
          (
            await sql(`SELECT read_at FROM alerts WHERE id = $1`, [
              (await alertFor(ids.occOverdue)).id,
            ])
          )[0],
        ).toEqual({ read_at: null });
      } finally {
        await failing.app.close();
      }
      await evaluate().expect(200);
      expect(await activeAlerts(occ)).toHaveLength(1);
    });

    it('escalates as time passes, without changing business data', async () => {
      const before = await snapshot();
      const soon = await alertFor(ids.chargeSoon);
      clock.advanceDays(3);
      try {
        const res = await evaluate().expect(200);
        expect(res.body.evaluationDate).toBe(clock.today());
        const current = await alertFor(ids.chargeSoon);
        expect(current.type).toBe('rent_charge_overdue');
        const [previous] = await sql(
          `SELECT state, resolution_reason FROM alerts WHERE id = $1`,
          [soon.id],
        );
        expect(previous).toEqual({
          state: 'resolved',
          resolution_reason: 'superseded',
        });
        // El contrato sigue activo: nunca se renueva ni se termina solo.
        const contract = (
          await h.as(camila).get(`/contracts/${ids.contractPassed}`).expect(200)
        ).body;
        expect(contract.status).toBe('active');
        expect((await alertFor(ids.contractPassed)).type).toBe(
          'contract_end_passed',
        );
        const after = await snapshot();
        expect(after[0]).toMatchObject({
          occ: before[0]!.occ,
          charges: before[0]!.charges,
          contracts: before[0]!.contracts,
        });
      } finally {
        clock.advanceDays(-3);
      }
    });

    it('never records an external delivery', async () => {
      const columns = await sql<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'alerts'`,
      );
      expect(
        columns.filter((c) => /deliver|sent|push|email/i.test(c.column_name)),
      ).toEqual([]);
    });
  });
});
