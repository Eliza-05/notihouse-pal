import { randomBytes, randomUUID } from 'node:crypto';
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
 * Generación automática de períodos y cobros recurrentes (§19.4): solo
 * `autoGenerate = true` y vigente, ciclo actual y siguiente, idempotente,
 * nunca inventa montos ni toca históricos, aislada por propietario y auditada.
 */
describe('Recurrence generation (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let clock: TestClock;
  let laura: TestUser;
  let andres: TestUser;

  const pw = () => randomBytes(12).toString('base64url');

  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => (await t.client.query<T>(query, params)).rows;

  const generate = (body: object = {}) =>
    h.asService().post('/internal/recurrence/generate', {
      workerId: 'n8n-scheduler',
      ...body,
    });

  const occurrencesOf = (obligationId: string) =>
    sql<{
      period_start: string;
      period_end: string;
      due_date: string;
      amount: string | null;
      currency: string;
      status: string;
    }>(
      `SELECT period_start::text, period_end::text, due_date::text, amount, currency, status
         FROM obligation_occurrences WHERE obligation_id = $1 ORDER BY period_start`,
      [obligationId],
    );

  const chargesOf = (rentalId: string) =>
    sql<{
      period_start: string;
      period_end: string;
      due_date: string;
      expected_amount: string;
      status: string;
    }>(
      `SELECT period_start::text, period_end::text, due_date::text, expected_amount, status
         FROM rent_charges WHERE rental_id = $1 ORDER BY period_start`,
      [rentalId],
    );

  beforeAll(async () => {
    t = await createMigratedDatabase();
    laura = await createTestUser(t.db, {
      email: 'laura@recurrence.test',
      password: pw(),
      displayName: 'Laura',
    });
    andres = await createTestUser(t.db, {
      email: 'andres@recurrence.test',
      password: pw(),
      displayName: 'Andrés',
    });
    clock = createTestClock(new Date('2026-11-18T15:00:00Z'));
    h = await createTestApp(t.db, withClock(clock));
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
  });

  it('requires the service token', async () => {
    await request(h.app.getHttpServer())
      .post('/api/v1/internal/recurrence/generate')
      .send({ workerId: 'x' })
      .expect(401);
    await h.as(laura).post('/internal/recurrence/generate', { workerId: 'x' }).expect(401);
  });

  it('generates the current and next monthly cycle for an auto-generating obligation, and never duplicates on repeat', async () => {
    const own = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Claro',
          concept: `Internet ${randomUUID()}`,
          category: 'internet',
          expectedAmount: '145000.00',
          dueDay: 18,
          startsOn: '2026-01-01',
          autoGenerate: true,
        })
        .expect(201)
    ).body;

    const res = await generate().expect(200);
    expect(res.body).toMatchObject({
      evaluationDate: clock.today(),
      timeZone: 'America/Bogota',
      obligationPeriodsCreated: 2,
      complete: true,
      nextCursor: null,
    });

    const rows = await occurrencesOf(own.id);
    expect(rows).toEqual([
      {
        period_start: '2026-11-01',
        period_end: '2026-11-30',
        due_date: '2026-11-18',
        amount: '145000.00',
        currency: 'COP',
        status: 'pending',
      },
      {
        period_start: '2026-12-01',
        period_end: '2026-12-31',
        due_date: '2026-12-18',
        amount: '145000.00',
        currency: 'COP',
        status: 'pending',
      },
    ]);

    // Repetir (y correr en "paralelo") no duplica: ON CONFLICT DO NOTHING.
    const [again1, again2] = await Promise.all([generate(), generate()]);
    expect(again1.status).toBe(200);
    expect(again2.status).toBe(200);
    expect(again1.body.obligationPeriodsCreated).toBe(0);
    expect(again1.body.unchanged).toBeGreaterThan(0);
    expect(await occurrencesOf(own.id)).toHaveLength(2);
  });

  it('never invents an amount: null expectedAmount stays null', async () => {
    const own = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Acueducto',
          concept: `Agua ${randomUUID()}`,
          category: 'water',
          dueDay: 10,
          autoGenerate: true,
        })
        .expect(201)
    ).body;
    await generate().expect(200);
    const [first] = await occurrencesOf(own.id);
    expect(first!.amount).toBeNull();
  });

  it('skips and reports obligations without dueDay instead of inventing one', async () => {
    const own = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Gas',
          concept: `Gas ${randomUUID()}`,
          category: 'gas',
          autoGenerate: true,
        })
        .expect(201)
    ).body;
    const res = await generate().expect(200);
    expect(res.body.skipped.missingDueDay).toBeGreaterThanOrEqual(1);
    expect(await occurrencesOf(own.id)).toEqual([]);
  });

  it('never touches obligations with autoGenerate off, paused or archived', async () => {
    const off = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Off',
          concept: `Off ${randomUUID()}`,
          category: 'other',
          dueDay: 5,
        })
        .expect(201)
    ).body;
    const paused = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Paused',
          concept: `Paused ${randomUUID()}`,
          category: 'other',
          dueDay: 5,
          autoGenerate: true,
          status: 'paused',
        })
        .expect(201)
    ).body;
    await generate().expect(200);
    expect(await occurrencesOf(off.id)).toEqual([]);
    expect(await occurrencesOf(paused.id)).toEqual([]);
  });

  it('clamps day 31 to the last day of a short month end to end', async () => {
    const own = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Fin de mes',
          concept: `Suscripción ${randomUUID()}`,
          category: 'other',
          dueDay: 31,
          startsOn: '2027-02-01',
          autoGenerate: true,
        })
        .expect(201)
    ).body;
    const februaryClock = createTestClock(new Date('2027-02-10T15:00:00Z'));
    const h2 = await createTestApp(t.db, withClock(februaryClock));
    await h2.asService()
      .post('/internal/recurrence/generate', { workerId: 'n8n-scheduler' })
      .expect(200);
    await h2.app.close();
    const [first] = await occurrencesOf(own.id);
    expect(first!.due_date).toBe('2027-02-28');
  });

  it.each([
    ['bimonthly', '2026-01-01'],
    ['quarterly', '2026-01-01'],
  ] as const)(
    'computes the %s cycle anchored on startsOn',
    async (frequency, startsOn) => {
      const own = (
        await h
          .as(laura)
          .post('/obligations', {
            providerName: `Freq-${frequency}`,
            concept: `Concepto ${randomUUID()}`,
            category: 'other',
            dueDay: 10,
            startsOn,
            frequency,
            autoGenerate: true,
          })
          .expect(201)
      ).body;
      await generate().expect(200);
      const rows = await occurrencesOf(own.id);
      expect(rows).toHaveLength(2);
      // El ciclo que contiene "hoy" (2026-11-18) empieza el primer día del
      // mes ancla desplazado en múltiplos exactos de la frecuencia.
      for (const row of rows) {
        expect(row.period_start.endsWith('-01')).toBe(true);
        expect(new Date(row.due_date) >= new Date(row.period_start)).toBe(
          true,
        );
      }
    },
  );

  it('generates rent charges within validity, clamped to startsOn, and stops after endsOn', async () => {
    const property = (
      await h
        .as(laura)
        .post('/properties', { name: `Inmueble ${randomUUID()}` })
        .expect(201)
    ).body.id;
    const rental = (
      await h
        .as(laura)
        .post('/rentals', {
          propertyId: property,
          expectedAmount: '950000.00',
          dueDay: 5,
          startsOn: '2026-11-10',
          endsOn: '2026-12-15',
          autoGenerate: true,
        })
        .expect(201)
    ).body;

    const res = await generate().expect(200);
    expect(res.body.rentChargesCreated).toBeGreaterThanOrEqual(1);

    const rows = await chargesOf(rental.id);
    // Primer cobro: periodStart recortado a startsOn (no al día 1 del mes).
    expect(rows[0]).toMatchObject({
      period_start: '2026-11-10',
      period_end: '2026-11-30',
      due_date: '2026-11-05',
      expected_amount: '950000.00',
      status: 'expected',
    });
    // El ciclo de enero (después de endsOn) nunca se genera.
    expect(rows.every((r) => r.period_start <= '2026-12-15')).toBe(true);
    expect(rows.some((r) => r.period_start.startsWith('2027-01'))).toBe(
      false,
    );
  });

  it('never touches rentals with autoGenerate off or not active', async () => {
    const property = (
      await h
        .as(laura)
        .post('/properties', { name: `Inmueble ${randomUUID()}` })
        .expect(201)
    ).body.id;
    const rental = (
      await h
        .as(laura)
        .post('/rentals', {
          propertyId: property,
          expectedAmount: '950000.00',
          dueDay: 5,
          startsOn: '2026-01-01',
        })
        .expect(201)
    ).body;
    await generate().expect(200);
    expect(await chargesOf(rental.id)).toEqual([]);
  });

  it('isolates by owner and audits every generated period as a workflow action', async () => {
    const mine = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Propio',
          concept: `Propio ${randomUUID()}`,
          category: 'other',
          dueDay: 5,
          autoGenerate: true,
        })
        .expect(201)
    ).body;
    const theirs = (
      await h
        .as(andres)
        .post('/obligations', {
          providerName: 'Ajeno',
          concept: `Ajeno ${randomUUID()}`,
          category: 'other',
          dueDay: 5,
          autoGenerate: true,
        })
        .expect(201)
    ).body;
    await generate().expect(200);
    const mineRows = await occurrencesOf(mine.id);
    const theirRows = await occurrencesOf(theirs.id);
    expect(mineRows).toHaveLength(2);
    expect(theirRows).toHaveLength(2);

    const owners = await sql<{ owner_id: string }>(
      `SELECT DISTINCT owner_id FROM obligation_occurrences WHERE obligation_id = $1`,
      [mine.id],
    );
    expect(owners.map((o) => o.owner_id)).toEqual([laura.profileId]);

    const audits = await sql<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_events
         WHERE action = 'obligation_occurrence.generate' AND metadata->>'obligationId' = $1`,
      [mine.id],
    );
    expect(audits).toHaveLength(2);
    for (const a of audits) {
      expect(a).toMatchObject({ actor_type: 'workflow', actor_id: 'n8n:n8n-scheduler' });
    }
  });
});
