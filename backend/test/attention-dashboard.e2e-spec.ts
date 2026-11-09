import { randomBytes } from 'node:crypto';
import { monthBounds } from '../src/due-dates/calendar.js';
import {
  attentionPriority,
  type DueDateRules,
  evaluateContract,
  evaluateOccurrence,
  evaluateRentCharge,
} from '../src/due-dates/due-date.rules.js';
import { createTestClock, type TestClock, withClock } from './support/clock.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const RULES: DueDateRules = {
  timeZone: 'America/Bogota',
  obligationDays: 7,
  rentChargeDays: 7,
  contractDays: 30,
  hitlSoonHours: 6,
};

interface Item {
  kind: string;
  id: string;
  condition: string;
  priority: number;
  relevantDate: string;
  daysUntil: number;
  status: string;
  title: string;
  description: string;
  suggestedAction: string;
  amount: string | null;
  currency: string | null;
  resource: { type: string; id: string; path: string };
  alert: { id: string; read: boolean } | null;
}

/**
 * Bandeja unificada y dashboard: solo lectura, filtrados por propietario en
 * PostgreSQL, con prioridad y orden determinísticos y montos exactos.
 */
describe('Attention inbox and dashboard (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let clock: TestClock;
  let laura: TestUser;
  let andres: TestUser;
  let daniel: TestUser;
  const ids = {} as Record<string, string>;
  /** Períodos de Laura: fecha, monto, moneda y estado final. */
  const lauraPeriods: {
    due: string;
    amount: string | null;
    currency: string;
    status: string;
  }[] = [];
  const andresCharges: { due: string; status: string }[] = [];

  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => (await t.client.query<T>(query, params)).rows;

  const attention = async (user: TestUser, query = '') =>
    (await h.as(user).get(`/attention${query}`).expect(200)).body as {
      referenceDate: string;
      items: Item[];
      total: number;
      page: number;
      pageSize: number;
    };

  beforeAll(async () => {
    t = await createMigratedDatabase();
    const pw = () => randomBytes(12).toString('base64url');
    [laura, andres, daniel] = await Promise.all(
      ['laura', 'andres', 'daniel'].map((name) =>
        createTestUser(t.db, {
          email: `${name}@inbox.test`,
          password: pw(),
          displayName: name,
        }),
      ),
    );
    clock = createTestClock();
    h = await createTestApp(t.db, withClock(clock));
    const d = clock.d;

    const obligation = async (body: object) =>
      (
        await h
          .as(laura)
          .post('/obligations', {
            providerName: 'Proveedor',
            category: 'other',
            reminderDaysBefore: 3,
            ...body,
          })
          .expect(201)
      ).body.id as string;
    ids.oblA = await obligation({ concept: 'Energía', expectedAmount: '1.00' });
    ids.oblB = await obligation({
      concept: 'Hosting',
      currency: 'USD',
      expectedAmount: '30.00',
    });
    ids.oblC = await obligation({ concept: 'Administración' });

    const period = async (
      key: string,
      obl: string,
      due: string,
      amount: string | null,
      currency = 'COP',
    ) => {
      ids[key] = (
        await h
          .as(laura)
          .post(`/obligations/${obl}/occurrences`, {
            periodStart: due,
            periodEnd: due,
            dueDate: due,
            ...(amount ? { amount } : {}),
          })
          .expect(201)
      ).body.id;
      lauraPeriods.push({ due, amount, currency, status: 'pending' });
    };
    await period('occOverdue', ids.oblA, d(-2), '100000.00');
    await period('occToday', ids.oblA, d(0), '50000.50');
    await period('occSoon', ids.oblA, d(3), '25000.25');
    await period('occFar', ids.oblA, d(20), '10000.00');
    await period('occPaid', ids.oblA, d(-1), '70000.00');
    await period('occCancelled', ids.oblA, d(1), '5.00');
    await period('occUsd', ids.oblB, d(5), null, 'USD');
    lauraPeriods[lauraPeriods.length - 1]!.amount = '30.00';
    await period('occNoAmount', ids.oblC, d(6), null);
    await h
      .as(laura)
      .post(`/obligations/${ids.oblA}/occurrences/${ids.occPaid}/confirm`, {
        result: 'paid',
      })
      .expect(200);
    lauraPeriods[4]!.status = 'paid';
    await h
      .as(laura)
      .patch(`/obligations/${ids.oblA}/occurrences/${ids.occCancelled}`, {
        status: 'cancelled',
      })
      .expect(200);
    lauraPeriods[5]!.status = 'cancelled';

    const lauraProperty = (
      await h.as(laura).post('/properties', { name: 'Apto Laura' }).expect(201)
    ).body.id as string;
    const contract = async (key: string, endsOn: string) => {
      ids[key] = (
        await h
          .as(laura)
          .post('/contracts', {
            propertyId: lauraProperty,
            startsOn: '2025-01-01',
            endsOn,
          })
          .expect(201)
      ).body.id;
    };
    await contract('contractSoon', d(10));
    await contract('contractPassed', d(-1));

    // Dos revisiones HITL: una con plazo holgado y otra a punto de vencer.
    const review = async () => {
      const c = (
        await h
          .as(laura)
          .post('/cases', { type: 'household_obligation' })
          .expect(201)
      ).body;
      const [job] = (
        await h
          .asService()
          .post('/internal/workflow-jobs/claim', { workerId: 'w1' })
          .expect(200)
      ).body.jobs;
      return (
        await h
          .asService()
          .post(`/internal/cases/${c.id}/hitl-requests`, {
            jobId: job.id,
            claimToken: job.claimToken,
            decisionType: 'data_confirmation',
            options: {
              summary: 'Texto sensible que no debe salir en la bandeja',
            },
          })
          .expect(201)
      ).body.id as string;
    };
    ids.hitlPending = await review();
    ids.hitlSoon = await review();
    await sql(
      `UPDATE hitl_requests SET due_at = $2::timestamptz + interval '2 hours' WHERE id = $1`,
      [ids.hitlSoon, clock.current.toISOString()],
    );

    // Andrés: arriendo con cobros.
    const andresProperty = (
      await h.as(andres).post('/properties', { name: 'Local' }).expect(201)
    ).body.id as string;
    ids.rental = (
      await h
        .as(andres)
        .post('/rentals', {
          propertyId: andresProperty,
          expectedAmount: '1200000.00',
          dueDay: 5,
          startsOn: '2025-01-01',
        })
        .expect(201)
    ).body.id;
    const charge = async (key: string, due: string) => {
      ids[key] = (
        await h
          .as(andres)
          .post(`/rentals/${ids.rental}/charges`, {
            periodStart: due,
            periodEnd: due,
            dueDate: due,
          })
          .expect(201)
      ).body.id;
      andresCharges.push({ due, status: 'expected' });
    };
    await charge('chargeOverdue', d(-3));
    await charge('chargeSoon', d(2));
    await charge('chargeReceived', d(-10));
    await charge('chargeFar', d(15));
    await h
      .as(andres)
      .post(`/rentals/${ids.rental}/charges/${ids.chargeReceived}/confirm`, {
        evidence: 'Transferencia',
      })
      .expect(200);
    andresCharges[2]!.status = 'received';
    // Un canon nuevo no altera los cobros ya registrados.
    await h
      .as(andres)
      .patch(`/rentals/${ids.rental}`, { expectedAmount: '1500000.00' })
      .expect(200);

    await h
      .asService()
      .post('/internal/alerts/evaluate', { workerId: 'n8n-scheduler' })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
  });

  describe('GET /attention', () => {
    it('requires a user JWT', async () => {
      await h.asService().get('/attention').expect(401);
    });

    it('returns a deterministic, prioritized list for the owner', async () => {
      const inbox = await attention(laura, '?pageSize=100');
      expect(inbox.referenceDate).toBe(clock.today());
      expect(inbox.items.map((i) => i.id)).toEqual([
        ids.hitlSoon,
        ids.occOverdue,
        ids.contractPassed,
        ids.occToday,
        ids.hitlPending,
        ids.occSoon,
        ids.occUsd,
        ids.occNoAmount,
        ids.contractSoon,
      ]);
      expect(inbox.items.map((i) => i.priority)).toEqual([
        1, 2, 2, 3, 4, 4, 4, 4, 4,
      ]);
      expect(inbox.total).toBe(9);
      // Excluidos: fuera del umbral, pagados y anulados.
      const listed = new Set(inbox.items.map((i) => i.id));
      for (const key of ['occFar', 'occPaid', 'occCancelled']) {
        expect(listed.has(ids[key]!), key).toBe(false);
      }
      expect(await attention(laura, '?pageSize=100')).toEqual(inbox);
    });

    it('describes each item for the frontend without sensitive content', async () => {
      const { items } = await attention(laura, '?pageSize=100');
      const byId = new Map(items.map((i) => [i.id, i]));
      expect(byId.get(ids.occOverdue)).toMatchObject({
        kind: 'obligation_occurrence',
        title: 'Energía — Proveedor',
        description: 'Venció hace 2 días',
        condition: 'overdue',
        status: 'pending',
        amount: '100000.00',
        currency: 'COP',
        suggestedAction: 'confirm_payment',
        resource: {
          type: 'obligation_occurrence',
          path: `/obligations/${ids.oblA}/occurrences/${ids.occOverdue}`,
        },
      });
      expect(byId.get(ids.occOverdue)!.alert).toMatchObject({ read: false });
      expect(byId.get(ids.occToday)).toMatchObject({
        description: 'Vence hoy',
        condition: 'due_today',
      });
      expect(byId.get(ids.contractPassed)).toMatchObject({
        title: 'Contrato: Apto Laura',
        description: 'Finalizó hace 1 día',
        suggestedAction: 'review_contract',
        status: 'active',
      });
      expect(byId.get(ids.hitlSoon)).toMatchObject({
        kind: 'hitl_request',
        title: 'Revisión: confirmación de datos',
        condition: 'due_soon',
        suggestedAction: 'decide_review',
        resource: { path: `/hitl-requests/${ids.hitlSoon}` },
      });
      expect(JSON.stringify(items)).not.toContain('Texto sensible');
    });

    it('classifies exactly like the due-date engine', async () => {
      const { items, referenceDate } = await attention(laura, '?pageSize=100');
      for (const item of items.filter((i) => i.kind !== 'hitl_request')) {
        const evaluation =
          item.kind === 'contract'
            ? evaluateContract(
                {
                  endsOn: item.relevantDate,
                  status: item.status,
                  noticePeriodDays: null,
                },
                RULES,
                referenceDate,
              )
            : evaluateOccurrence(
                {
                  dueDate: item.relevantDate,
                  status: item.status,
                  reminderDaysBefore: 3,
                },
                RULES,
                referenceDate,
              );
        expect(item.condition).toBe(evaluation.condition);
        expect(item.daysUntil).toBe(evaluation.daysUntil);
        expect(item.priority).toBe(
          attentionPriority(item.kind as 'contract', evaluation.condition),
        );
      }
      for (const item of (await attention(andres)).items) {
        const evaluation = evaluateRentCharge(
          { dueDate: item.relevantDate, status: item.status },
          RULES,
          referenceDate,
        );
        expect(item.condition).toBe(evaluation.condition);
      }
    });

    it('paginates over the unified set with a stable order', async () => {
      const full = await attention(laura, '?pageSize=100');
      const collected: Item[] = [];
      for (let page = 1; page <= 4; page++) {
        const res = await attention(laura, `?pageSize=3&page=${page}`);
        expect(res.total).toBe(full.total);
        collected.push(...res.items);
      }
      expect(collected.map((i) => i.id)).toEqual(full.items.map((i) => i.id));
      const kind = await attention(laura, '?kind=contract');
      expect(kind.items.map((i) => i.id)).toEqual([
        ids.contractPassed,
        ids.contractSoon,
      ]);
      expect(kind.total).toBe(2);
      await h.as(laura).get('/attention?kind=payments').expect(400);
      await h.as(laura).get('/attention?pageSize=101').expect(400);
    });

    it('isolates owners and returns an empty inbox without errors', async () => {
      const andresInbox = await attention(andres);
      expect(andresInbox.items.map((i) => i.id)).toEqual([
        ids.chargeOverdue,
        ids.chargeSoon,
      ]);
      expect(andresInbox.items[0]).toMatchObject({
        title: 'Cobro de arriendo: Local',
        amount: '1200000.00',
        suggestedAction: 'confirm_receipt',
        resource: {
          path: `/rentals/${ids.rental}/charges/${ids.chargeOverdue}`,
        },
      });
      expect(await attention(daniel)).toMatchObject({ items: [], total: 0 });
      await h
        .as(andres)
        .get(`/attention?ownerId=${laura.profileId}`)
        .expect(400);
    });
  });

  describe('GET /dashboard/summary', () => {
    const inMonth = (date: string) => {
      const { start, next } = monthBounds(clock.today());
      return date >= start && date < next;
    };
    const cents = (values: (string | null)[]) =>
      (
        values.reduce(
          (sum, v) => sum + (v ? BigInt(v.replace('.', '')) : 0n),
          0n,
        ) as bigint
      ).toString();
    const asMoney = (centsValue: string) =>
      `${centsValue.slice(0, -2) || '0'}.${centsValue.slice(-2).padStart(2, '0')}`;
    const money = (values: (string | null)[]) =>
      asMoney(cents(values).padStart(3, '0'));

    it('requires a user JWT', async () => {
      await h.asService().get('/dashboard/summary').expect(401);
    });

    it('returns exact counts for the owner', async () => {
      const body = (await h.as(laura).get('/dashboard/summary').expect(200))
        .body;
      expect(body).toMatchObject({
        referenceDate: clock.today(),
        timeZone: 'America/Bogota',
        properties: { total: 1, active: 1 },
        obligations: {
          active: 3,
          periodsPending: 5,
          periodsOverdue: 1,
          periodsDueSoon: 4,
          periodsConfirmed: 1,
        },
        rentCharges: { pending: 0, overdue: 0, dueSoon: 0, received: 0 },
        contracts: { active: 2, endingSoon: 1, endPassed: 1 },
        hitl: { pending: 2 },
        // D6: con reminderDaysBefore=3, occUsd (d(5)) y occNoAmount (d(6))
        // ya no emiten obligation_due_soon (quedan fuera de la ventana
        // personalizada), aunque sigan contando en periodsDueSoon (ventana
        // general, sin cambios): 9 - 2 = 7.
        alerts: { active: 7, unread: 7 },
        cases: { open: 2 },
      });
    });

    it('sums money exactly, per currency, separating expected from confirmed', async () => {
      const body = (await h.as(laura).get('/dashboard/summary').expect(200))
        .body;
      const open = lauraPeriods.filter((p) => p.status === 'pending');
      expect(body.money.obligationsOpen).toEqual([
        {
          currency: 'COP',
          total: money(
            open.filter((p) => p.currency === 'COP').map((p) => p.amount),
          ),
          count: 5,
          withoutAmount: 1,
        },
        { currency: 'USD', total: '30.00', count: 1, withoutAmount: 0 },
      ]);
      expect(body.money.obligationsOpen[0].total).toBe('185000.75');
      expect(body.money.month).toEqual({
        start: monthBounds(clock.today()).start,
        end: monthBounds(clock.today()).next,
      });
      const month = lauraPeriods.filter((p) => inMonth(p.due));
      const expectedRows = ['COP', 'USD']
        .filter((cur) => month.some((p) => p.currency === cur))
        .map((cur) => ({
          currency: cur,
          expected: money(
            month
              .filter((p) => p.currency === cur && p.status !== 'cancelled')
              .map((p) => p.amount),
          ),
          confirmed: money(
            month
              .filter((p) => p.currency === cur && p.status === 'paid')
              .map((p) => p.amount),
          ),
        }));
      expect(body.money.obligationsThisMonth).toEqual(expectedRows);
      expect(body.money.note).toMatch(/no son saldos bancarios/i);
      expect(typeof body.money.obligationsOpen[0].total).toBe('string');
    });

    it('keeps expected rent separate from received rent', async () => {
      const body = (await h.as(andres).get('/dashboard/summary').expect(200))
        .body;
      expect(body.rentCharges).toEqual({
        pending: 2,
        overdue: 1,
        dueSoon: 1,
        received: 1,
      });
      // Cobros abiertos: el canon nuevo no cambia su valor histórico.
      expect(body.money.rentOpen).toEqual([
        { currency: 'COP', total: '3600000.00', count: 3, withoutAmount: 0 },
      ]);
      const month = andresCharges.filter((c) => inMonth(c.due));
      expect(body.money.rentThisMonth).toEqual(
        month.length === 0
          ? []
          : [
              {
                currency: 'COP',
                expected: money(month.map(() => '1200000.00')),
                received: money(
                  month
                    .filter((c) => c.status === 'received')
                    .map(() => '1200000.00'),
                ),
              },
            ],
      );
      expect(body.obligations.periodsPending).toBe(0);
      expect(body.contracts.active).toBe(0);
    });

    it('returns valid zeros for a user without data', async () => {
      const body = (await h.as(daniel).get('/dashboard/summary').expect(200))
        .body;
      expect(body).toMatchObject({
        properties: { total: 0, active: 0 },
        obligations: {
          active: 0,
          periodsPending: 0,
          periodsOverdue: 0,
          periodsDueSoon: 0,
          periodsConfirmed: 0,
        },
        rentCharges: { pending: 0, overdue: 0, dueSoon: 0, received: 0 },
        contracts: { active: 0, endingSoon: 0, endPassed: 0 },
        hitl: { pending: 0 },
        alerts: { active: 0, unread: 0 },
        cases: { open: 0 },
        money: {
          obligationsOpen: [],
          rentOpen: [],
          obligationsThisMonth: [],
          rentThisMonth: [],
        },
      });
    });

    it('updates unread alerts after reading one', async () => {
      const { items } = await attention(laura, '?pageSize=100');
      const alertId = items.find((i) => i.id === ids.occSoon)!.alert!.id;
      await h.as(laura).post(`/alerts/${alertId}/read`).expect(200);
      const body = (await h.as(laura).get('/dashboard/summary').expect(200))
        .body;
      expect(body.alerts).toEqual({ active: 7, unread: 6 });
      expect(
        (await attention(laura, '?pageSize=100')).items.find(
          (i) => i.id === ids.occSoon,
        )!.alert,
      ).toEqual({ id: alertId, read: true });
    });
  });

  it('never writes during GET requests', async () => {
    const state = () =>
      sql(
        `SELECT (SELECT count(*) FROM audit_events) AS audit,
                (SELECT count(*) FROM alerts) AS alerts,
                (SELECT max(updated_at) FROM alerts) AS alerts_updated,
                (SELECT max(updated_at) FROM obligation_occurrences) AS occ_updated,
                (SELECT max(updated_at) FROM rent_charges) AS charges_updated,
                (SELECT max(updated_at) FROM contracts) AS contracts_updated,
                (SELECT max(updated_at) FROM hitl_requests) AS hitl_updated`,
      );
    const before = await state();
    for (const user of [laura, andres, daniel]) {
      await h.as(user).get('/dashboard/summary').expect(200);
      await h.as(user).get('/attention').expect(200);
      await h.as(user).get('/alerts').expect(200);
    }
    // Una revisión vencida sin decidir se informa, pero GET no la materializa.
    await sql(
      `UPDATE hitl_requests SET created_at = now() - interval '2 days', due_at = $2::timestamptz - interval '1 hour' WHERE id = $1`,
      [ids.hitlSoon, clock.current.toISOString()],
    );
    const snapshot = await state();
    const inbox = await attention(laura, '?pageSize=100');
    expect(inbox.items[0]).toMatchObject({
      id: ids.hitlSoon,
      condition: 'overdue',
      priority: 1,
      suggestedAction: 'view_review',
    });
    expect(await state()).toEqual(snapshot);
    expect(before[0]!.audit).toBe(snapshot[0]!.audit);
  });
});
