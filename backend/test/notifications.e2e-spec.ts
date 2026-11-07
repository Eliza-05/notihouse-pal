import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { createTestClock, type TestClock, withClock } from './support/clock.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Etapa 7 · Fase 9: notificaciones internas web PERSISTENTES (N1–N12).
 * Decisión del MVP: sin FCM ni WebSockets; las alertas se guardan en
 * PostgreSQL y el frontend las consulta por polling (60 s, configurable).
 * Se separan los tiempos: A (condición → evaluación) depende del scheduler,
 * B (evaluación → persistencia) y C (persistencia → consulta) se miden aquí.
 */
describe('Persistent internal notifications N1–N12 (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let clock: TestClock;
  const users = {} as Record<
    'daniel' | 'laura' | 'andres' | 'camila',
    TestUser
  >;
  const ids = {} as Record<string, string>;
  const timings: Record<string, number | number[]> = {};

  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => (await t.client.query<T>(query, params)).rows;
  const evaluate = () =>
    h
      .asService()
      .post('/internal/alerts/evaluate', { workerId: 'n8n-scheduler' });
  const summary = (u: TestUser) => h.as(u).get('/alerts/summary').expect(200);
  const alertsOf = async (u: TestUser, q = '') =>
    (await h.as(u).get(`/alerts?pageSize=100${q}`).expect(200)).body;
  const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;

  beforeAll(async () => {
    t = await createMigratedDatabase();
    const pw = () => randomBytes(12).toString('base64url');
    for (const name of ['daniel', 'laura', 'andres', 'camila'] as const) {
      users[name] = await createTestUser(t.db, {
        email: `${name}@notif.test`,
        password: pw(),
        displayName: name,
      });
    }
    clock = createTestClock();
    h = await createTestApp(t.db, withClock(clock));
    const d = clock.d;
    // Laura: un período que entra en el umbral (7 días por defecto) dentro de 2 días.
    ids.obligation = (
      await h
        .as(users.laura)
        .post('/obligations', {
          providerName: 'Empresa de energía',
          concept: 'Energía',
          category: 'electricity',
          reminderDaysBefore: 3,
        })
        .expect(201)
    ).body.id;
    ids.occ = (
      await h
        .as(users.laura)
        .post(`/obligations/${ids.obligation}/occurrences`, {
          periodStart: d(-25),
          periodEnd: d(9),
          dueDate: d(9),
          amount: '145000.00',
        })
        .expect(201)
    ).body.id;
    // Daniel: un período propio, para comprobar aislamiento.
    const danielObl = (
      await h
        .as(users.daniel)
        .post('/obligations', {
          providerName: 'Internet Demo',
          concept: 'Internet',
          category: 'internet',
          reminderDaysBefore: 3,
        })
        .expect(201)
    ).body.id;
    await h
      .as(users.daniel)
      .post(`/obligations/${danielObl}/occurrences`, {
        periodStart: d(-10),
        periodEnd: d(8),
        dueDate: d(8),
        amount: '98500.00',
      })
      .expect(201);
    // Andrés: cobro de arriendo; Camila: contrato.
    const prop = async (u: TestUser) =>
      (await h.as(u).post('/properties', { name: 'Inmueble' }).expect(201)).body
        .id as string;
    const rental = (
      await h
        .as(users.andres)
        .post('/rentals', {
          propertyId: await prop(users.andres),
          expectedAmount: '1200000.00',
          dueDay: 5,
          startsOn: '2025-01-01',
        })
        .expect(201)
    ).body.id;
    await h
      .as(users.andres)
      .post(`/rentals/${rental}/charges`, {
        periodStart: d(-20),
        periodEnd: d(10),
        dueDate: d(-1),
      })
      .expect(201);
    await h
      .as(users.camila)
      .post('/contracts', {
        propertyId: await prop(users.camila),
        startsOn: d(-300),
        endsOn: d(10),
      })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
    if (process.env.STAGE7_EVIDENCE_DIR) {
      mkdirSync(process.env.STAGE7_EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        join(process.env.STAGE7_EVIDENCE_DIR, 'notification-timings.json'),
        JSON.stringify(timings, null, 2),
      );
    }
  });

  it('N1/N2: the rule creates the alert while no user session exists (no JWT issued at all)', async () => {
    // Antes de que entre en el umbral: nada.
    await evaluate().expect(200);
    expect(
      await sql(`SELECT 1 FROM alerts WHERE occurrence_id = $1`, [ids.occ]),
    ).toHaveLength(0);
    // Pasan 2 días sin que nadie abra la aplicación; el scheduler evalúa.
    clock.advanceDays(2);
    const start = process.hrtime.bigint();
    const res = await evaluate().expect(200);
    timings.B_evaluationToPersistenceMs = ms(start);
    expect(res.body.created).toBeGreaterThanOrEqual(1);
    const [row] = await sql<{
      type: string;
      state: string;
      read_at: Date | null;
    }>(`SELECT type, state, read_at FROM alerts WHERE occurrence_id = $1`, [
      ids.occ,
    ]);
    expect(row).toEqual({
      type: 'obligation_due_soon',
      state: 'active',
      read_at: null,
    });
    // La evaluación no registra ninguna entrega externa.
    const events = await sql<{ action: string }>(
      `SELECT DISTINCT action FROM audit_events WHERE component = 'process.alerts'`,
    );
    expect(events.map((e) => e.action).join()).not.toMatch(
      /push|send|deliver|fcm|email/i,
    );
  });

  it('N3: the user logs in the next day and recovers the persisted alert through the API', async () => {
    clock.advanceDays(1); // sin nueva evaluación: la alerta ya estaba guardada
    const start = process.hrtime.bigint();
    const page = await alertsOf(users.laura); // token nuevo = nueva sesión
    timings.C_persistenceToQueryMs = ms(start);
    const alert = page.items.find(
      (a: { resource: { id: string } }) => a.resource.id === ids.occ,
    );
    expect(alert).toMatchObject({
      type: 'obligation_due_soon',
      requiresAttention: true,
      read: false,
      resource: { type: 'obligation_occurrence', id: ids.occ },
    });
    expect(alert.title).toBeTruthy();
    expect(alert.message).toMatch(/vence/);
    ids.alert = alert.id;
  });

  it('N4: the bell counter counts unread active alerts', async () => {
    const s = (await summary(users.laura)).body;
    expect(s).toMatchObject({ unread: 1, active: 1 });
    expect(new Date(s.latestCreatedAt).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    const dashboard = (
      await h.as(users.laura).get('/dashboard/summary').expect(200)
    ).body;
    expect(dashboard.alerts).toEqual({ active: 1, unread: 1 });
  });

  it('N5: marking as read updates the alert only (the obligation is untouched)', async () => {
    const before = await sql(
      `SELECT status, amount, due_date::text FROM obligation_occurrences WHERE id = $1`,
      [ids.occ],
    );
    await h.as(users.laura).post(`/alerts/${ids.alert}/read`).expect(200);
    await h.as(users.laura).post(`/alerts/${ids.alert}/read`).expect(200); // idempotente
    expect((await summary(users.laura)).body).toMatchObject({
      unread: 0,
      active: 1,
    });
    expect(
      await sql(
        `SELECT status, amount, due_date::text FROM obligation_occurrences WHERE id = $1`,
        [ids.occ],
      ),
    ).toEqual(before);
    const [{ n }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'alert.read' AND metadata->>'resourceId' = $1`,
      [ids.alert],
    );
    expect(n).toBe(1);
  });

  it('N7: repeated evaluations never duplicate the alert', async () => {
    const before = await sql(`SELECT count(*)::int AS n FROM alerts`);
    for (let i = 0; i < 5; i++) await evaluate().expect(200);
    await Promise.all([evaluate(), evaluate(), evaluate()]);
    expect(await sql(`SELECT count(*)::int AS n FROM alerts`)).toEqual(before);
    const rows = await sql(
      `SELECT id FROM alerts WHERE occurrence_id = $1 AND state = 'active'`,
      [ids.occ],
    );
    expect(rows).toHaveLength(1);
  });

  it('N9: every user sees only their own alerts and counters (4 accounts)', async () => {
    const seen: Record<string, string[]> = {};
    for (const [name, u] of Object.entries(users)) {
      seen[name] = (await alertsOf(u)).items.map(
        (a: { type: string }) => a.type,
      );
    }
    expect(seen.laura).toEqual(['obligation_due_soon']);
    expect(seen.daniel).toEqual(['obligation_due_soon']);
    expect(seen.andres).toEqual(['rent_charge_overdue']);
    expect(seen.camila).toEqual(['contract_ending_soon']);
    const lauraAlert = ids.alert;
    for (const other of [users.daniel, users.andres, users.camila]) {
      await h.as(other).get(`/alerts/${lauraAlert}`).expect(404);
      await h.as(other).post(`/alerts/${lauraAlert}/read`).expect(404);
      await h.as(other).post(`/alerts/${lauraAlert}/dismiss`).expect(404);
      expect((await summary(other)).body.active).toBe(1);
    }
    // El token del servicio no lee alertas de usuarios.
    await h.asService().get('/alerts/summary').expect(401);
  });

  it('N10: with n8n off, stored alerts stay available; missed evaluations are recovered on return', async () => {
    // n8n apagado 8 días: nadie evalúa. Las alertas guardadas siguen ahí.
    clock.advanceDays(8); // el período venció hace 2 días
    expect((await alertsOf(users.laura)).items).toHaveLength(1);
    // Al volver, UNA evaluación recupera el estado actual (no hay que
    // reproducir los días perdidos): la alerta escala a vencida.
    await evaluate().expect(200);
    const rows = await sql<{ type: string; state: string }>(
      `SELECT type, state FROM alerts WHERE occurrence_id = $1 ORDER BY created_at`,
      [ids.occ],
    );
    expect(rows.map((r) => `${r.type}:${r.state}`)).toEqual([
      'obligation_due_soon:resolved',
      'obligation_overdue:active',
    ]);
    // La nueva alerta llega como no leída.
    expect((await summary(users.laura)).body).toMatchObject({
      unread: 1,
      active: 1,
    });
  });

  it('N8: once the payment is confirmed no more pending-payment alerts are produced for that period', async () => {
    await h
      .as(users.laura)
      .post(`/obligations/${ids.obligation}/occurrences/${ids.occ}/confirm`, {
        result: 'paid',
      })
      .expect(200);
    // Inmediatamente deja de contar, aunque la evaluación no haya corrido.
    expect((await summary(users.laura)).body).toMatchObject({
      unread: 0,
      active: 0,
    });
    await evaluate().expect(200);
    clock.advanceDays(1);
    await evaluate().expect(200);
    const rows = await sql<{ state: string; resolution_reason: string }>(
      `SELECT state, resolution_reason FROM alerts WHERE occurrence_id = $1 ORDER BY created_at`,
      [ids.occ],
    );
    expect(rows.every((r) => r.state === 'resolved')).toBe(true);
    expect(rows.at(-1)!.resolution_reason).toBe('resource_closed');
    // El historial se conserva y se puede consultar.
    expect((await alertsOf(users.laura, '&state=resolved')).items.length).toBe(
      2,
    );
  });

  it('N6: dismissing hides the alert without changing any financial state', async () => {
    const [{ id }] = await sql<{ id: string }>(
      `SELECT a.id FROM alerts a WHERE a.owner_id = $1 AND a.state = 'active'`,
      [users.andres.profileId],
    );
    const charge = () =>
      sql(`SELECT status, confirmed_by FROM rent_charges WHERE owner_id = $1`, [
        users.andres.profileId,
      ]);
    const before = await charge();
    await h.as(users.andres).post(`/alerts/${id}/dismiss`).expect(200);
    expect(await charge()).toEqual(before);
    expect((await summary(users.andres)).body).toMatchObject({ active: 0 });
    // No se recrea en la siguiente evaluación.
    await evaluate().expect(200);
    expect((await summary(users.andres)).body.active).toBe(0);
    expect(
      (await alertsOf(users.andres, '&state=dismissed')).items,
    ).toHaveLength(1);
  });

  it('N12: the polling contract — no-store, auth required, read-only and cheap', async () => {
    const server = h.app.getHttpServer();
    const res = await summary(users.camila);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(
      (await h.as(users.camila).get('/alerts').expect(200)).headers[
        'cache-control'
      ],
    ).toBe('no-store');
    await request(server).get('/api/v1/alerts/summary').expect(401);
    await request(server)
      .get('/api/v1/alerts/summary')
      .set('Authorization', 'Bearer token.invalido.x')
      .expect(401);
    const auditBefore = await sql(
      `SELECT count(*)::int AS n FROM audit_events`,
    );
    const latencies: number[] = [];
    // 60 consultas = una hora de polling a 60 s de un usuario.
    for (let i = 0; i < 60; i++) {
      const start = process.hrtime.bigint();
      const r = await summary(users.camila);
      latencies.push(ms(start));
      expect(r.body.active).toBe(1);
    }
    expect(await sql(`SELECT count(*)::int AS n FROM audit_events`)).toEqual(
      auditBefore,
    );
    latencies.sort((a, b) => a - b);
    timings.C_summaryPollingMs = {
      p50: latencies[29],
      p95: latencies[56],
      max: latencies[59],
    } as unknown as number[];
    expect(latencies[56]).toBeLessThan(1000);
  });

  it('N11: a pending HITL appears in the attention inbox and as ONE internal alert, escalating without duplicates', async () => {
    // Revisión pendiente de Daniel creada por el flujo normal (caso → trabajo → HITL).
    await sql(
      `UPDATE workflow_jobs SET status = 'cancelled', locked_until = NULL WHERE status IN ('pending','claimed')`,
    );
    const c = (
      await h
        .as(users.daniel)
        .post('/cases', { type: 'household_obligation' })
        .expect(201)
    ).body;
    const [job] = (
      await h
        .asService()
        .post('/internal/workflow-jobs/claim', { workerId: 'w1' })
        .expect(200)
    ).body.jobs;
    const hitl = (
      await h
        .asService()
        .post(`/internal/cases/${c.id}/hitl-requests`, {
          jobId: job.id,
          claimToken: job.claimToken,
          decisionType: 'other',
          options: { summary: 'Revisa la factura' },
        })
        .expect(201)
    ).body;
    // El plazo de la revisión lo fija PostgreSQL (now() + 24 h); el reloj de
    // la prueba va adelantado, así que se alinea con él.
    await sql(
      `UPDATE hitl_requests SET created_at = $1, due_at = $1::timestamptz + interval '24 hours' WHERE id = $2`,
      [clock.current.toISOString(), hitl.id],
    );
    const inbox = (await h.as(users.daniel).get('/attention').expect(200)).body;
    expect(JSON.stringify(inbox)).toContain(hitl.id);
    await evaluate().expect(200);
    await evaluate().expect(200);
    const hitlAlerts = await sql<{ type: string; state: string }>(
      `SELECT type, state FROM alerts WHERE hitl_request_id = $1`,
      [hitl.id],
    );
    expect(hitlAlerts).toEqual([{ type: 'hitl_pending', state: 'active' }]);
    // Al decidir, la alerta deja de estar vigente: sin avisos repetidos.
    await h
      .as(users.daniel)
      .post(`/hitl-requests/${hitl.id}/decision`, { decision: 'rejected' })
      .expect(200);
    await evaluate().expect(200);
    const after = await sql<{ state: string }>(
      `SELECT state FROM alerts WHERE hitl_request_id = $1`,
      [hitl.id],
    );
    expect(after.map((r) => r.state)).toEqual(['resolved']);
  });
});
