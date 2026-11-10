import { addDays, calendarDateIn } from '../../src/due-dates/calendar.js';
import { Harness, recordEvidence, statuses } from './support/harness.js';

const today = () => calendarDateIn(new Date(), 'America/Bogota');
const EVALUATE = '/internal/alerts/evaluate';

describe('Escenario J — alertas y dashboard en PostgreSQL real', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
    await h.retireOpenWork();
  });
  afterAll(() => h.close());

  const evaluate = (i = 0, body: object = {}) =>
    (i % 2 ? h.apiA : h.apiB).service.post(EVALUATE, {
      workerId: `scheduler-${i}`,
      batchSize: 50,
      ...body,
    });
  const alertsOf = (occurrence: string) =>
    h.sql(
      `SELECT id, state, dedup_key, resolution_reason FROM alerts WHERE occurrence_id = $1 ORDER BY created_at`,
      [occurrence],
    );

  it('evaluaciones simultáneas del mismo vencimiento: una alerta activa', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const occurrence = await h.occurrence(user, obligation, today());
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => evaluate(i)),
    );
    expect(statuses(results)).toEqual([200, 200, 200, 200, 200, 200]);
    const rows = await alertsOf(occurrence);
    expect(rows.filter((a) => a.state === 'active')).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(await h.audit('alert.create', rows[0]!.id as string)).toBe(1);
    // Repetir el mismo día no crea nada.
    await evaluate();
    await evaluate(1);
    expect(await alertsOf(occurrence)).toHaveLength(1);
  });

  it('muchas alertas re-etiquetadas con barridos en paralelo no se interbloquean', async () => {
    const user = await h.newUser();
    // La ventana de alerta es el aviso propio de la obligación (D6; por defecto 3
    // días). Con 10 días, los vencimientos sembrados (1-5 días, luego 2-6) quedan
    // todos dentro de la ventana: las 30 alertas se re-etiquetan.
    const obligation = await h.obligation(user, 'Energía', {
      reminderDaysBefore: 10,
    });
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(
        await h.occurrence(
          user,
          obligation,
          addDays(today(), 1 + (i % 5)),
          `2020-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
        ),
      );
    }
    await evaluate();
    // Todas cambian de fecha: los barridos resuelven y crean en órdenes distintos.
    await h.sql(
      `UPDATE obligation_occurrences SET due_date = due_date + 1 WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const deadlocks = () =>
      h.count(
        `SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`,
      );
    const before = await deadlocks();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => evaluate(i, { batchSize: 5 })),
    );
    await h.sql(`SELECT pg_stat_force_next_flush()`);
    recordEvidence('alerts-parallel-rekey', {
      statuses: statuses(results),
      deadlocksDelta: (await deadlocks()) - before,
    });
    expect(statuses(results)).toEqual(results.map(() => 200));
    const active = await h.sql(
      `SELECT occurrence_id, count(*)::int AS n FROM alerts
        WHERE occurrence_id = ANY($1::uuid[]) AND state = 'active'
        GROUP BY occurrence_id`,
      [ids],
    );
    expect(active).toHaveLength(30);
    expect(active.every((r) => r.n === 1)).toBe(true);
  });

  it('un cambio de fecha resuelve la alerta anterior y crea otra', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const occurrence = await h.occurrence(user, obligation, today());
    await evaluate();
    const moved = await user.a.patch(
      `/obligations/${obligation}/occurrences/${occurrence}`,
      { dueDate: addDays(today(), 2) },
    );
    expect(moved.status).toBe(200);
    const results = await Promise.all([evaluate(0), evaluate(1), evaluate(2)]);
    expect(statuses(results)).toEqual([200, 200, 200]);
    const rows = await alertsOf(occurrence);
    expect(rows.map((a) => a.state)).toEqual(['resolved', 'active']);
    expect(rows[0]!.resolution_reason).toBe('superseded');
  });

  it('confirmar una obligación durante la evaluación no la confirma por automatización ni deja avisos falsos', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const occurrence = await h.occurrence(user, obligation, today());
    const results = await Promise.all([
      evaluate(0),
      user.a.post(
        `/obligations/${obligation}/occurrences/${occurrence}/confirm`,
        {
          result: 'paid',
        },
      ),
      evaluate(1),
    ]);
    expect(statuses(results)).toEqual([200, 200, 200]);
    // Tras estabilizarse: la vista de usuario nunca muestra aviso pendiente.
    const listed = await user.a.get('/alerts?state=active');
    expect(listed.body.items).toEqual([]);
    await evaluate();
    const rows = await alertsOf(occurrence);
    expect(rows.filter((a) => a.state === 'active')).toEqual([]);
    const [row] = await h.sql(
      `SELECT status, confirmed_by FROM obligation_occurrences WHERE id = $1`,
      [occurrence],
    );
    expect(row).toEqual({ status: 'paid', confirmed_by: user.profileId });
  });

  it('confirmar un cobro durante la evaluación mantiene la recepción humana', async () => {
    const user = await h.newUser();
    const rental = await h.rental(user);
    const charge = await h.charge(user, rental, today());
    const results = await Promise.all([
      evaluate(0),
      user.b.post(`/rentals/${rental}/charges/${charge}/confirm`, {
        evidence: 'Recibido',
      }),
      evaluate(1),
    ]);
    expect(statuses(results)).toEqual([200, 200, 200]);
    await evaluate();
    const active = await h.count(
      `SELECT count(*) AS n FROM alerts WHERE rent_charge_id = $1 AND state = 'active'`,
      [charge],
    );
    expect(active).toBe(0);
    const [row] = await h.sql(`SELECT status FROM rent_charges WHERE id = $1`, [
      charge,
    ]);
    expect(row!.status).toBe('received');
    // Un cobro sin confirmar jamás pasa a recibido por evaluarse. Vence en otro
    // mes: con "hoy − 3" el período coincidía con el del cobro anterior (mismo
    // arriendo) los días 4 a 31 y el backend lo rechazaba, con razón, por solapado.
    const untouched = await h.charge(user, rental, addDays(today(), -40));
    await evaluate();
    const [open] = await h.sql(
      `SELECT status, confirmed_at FROM rent_charges WHERE id = $1`,
      [untouched],
    );
    expect(open).toEqual({ status: 'expected', confirmed_at: null });
  });

  it('descartar compitiendo con la evaluación se respeta sin reabrir', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const occurrence = await h.occurrence(user, obligation, today());
    await evaluate();
    const [alert] = await alertsOf(occurrence);
    const { results } = await h.behindLock(
      'alert-dismiss-vs-evaluate',
      { table: 'alerts', id: alert!.id as string },
      2,
      () => [user.a.post(`/alerts/${alert!.id}/dismiss`), evaluate(0)],
    );
    expect(statuses(results)).toEqual([200, 200]);
    await evaluate(1);
    const rows = await alertsOf(occurrence);
    expect(rows.map((a) => a.state)).toEqual(['dismissed']);
    expect(await h.audit('alert.dismiss', alert!.id as string)).toBe(1);
  });

  it('un barrido parcial se reanuda con nextCursor y un cursor ajeno se rechaza', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const occurrences: string[] = [];
    for (let i = 0; i < 6; i++) {
      occurrences.push(
        await h.occurrence(
          user,
          obligation,
          today(),
          `2021-01-${String(i + 1).padStart(2, '0')}`,
        ),
      );
    }
    let cursor: string | undefined;
    let rounds = 0;
    for (;;) {
      const res = await evaluate(rounds, {
        batchSize: 2,
        maxBatches: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(res.status).toBe(200);
      rounds += 1;
      if (res.body.complete) break;
      cursor = res.body.nextCursor as string;
      // Otro barrido se cuela en mitad del parcial.
      if (rounds === 2) await evaluate(9, { batchSize: 1, maxBatches: 1 });
      expect(rounds).toBeLessThan(200);
    }
    expect(rounds).toBeGreaterThan(1);
    const active = await h.count(
      `SELECT count(*) AS n FROM alerts WHERE occurrence_id = ANY($1::uuid[]) AND state = 'active'`,
      [occurrences],
    );
    expect(active).toBe(6);
    expect((await evaluate(0, { cursor: 'no-es-un-cursor' })).status).toBe(400);
  });

  it('aislamiento: cada propietario solo ve lo suyo, también en paralelo', async () => {
    const [alice, bob] = [await h.newUser(), await h.newUser()];
    const [oa, ob] = [await h.obligation(alice), await h.obligation(bob)];
    const [ca, cb] = [
      await h.occurrence(alice, oa, today()),
      await h.occurrence(bob, ob, today()),
    ];
    await evaluate();
    const reads = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 ? alice.a.get('/alerts') : bob.b.get('/alerts'),
      ),
    );
    reads.forEach((res, i) => {
      const expected = i % 2 ? ca : cb;
      const other = i % 2 ? cb : ca;
      const resources = (res.body.items as { resource: { id: string } }[]).map(
        (a) => a.resource.id,
      );
      expect(resources).toContain(expected);
      expect(resources).not.toContain(other);
    });
    const [aliceAlert] = await alertsOf(ca);
    expect((await bob.a.get(`/alerts/${aliceAlert!.id}`)).status).toBe(404);
    expect((await bob.a.post(`/alerts/${aliceAlert!.id}/dismiss`)).status).toBe(
      404,
    );
  });

  it('dashboard y bandeja coinciden con los datos finales; los GET no escriben', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const paid = await h.occurrence(user, obligation, today(), '2022-01-01');
    await h.occurrence(user, obligation, addDays(today(), 2), '2022-02-01');
    await h.occurrence(user, obligation, addDays(today(), -5), '2022-03-01');
    await evaluate();
    await user.a.post(
      `/obligations/${obligation}/occurrences/${paid}/confirm`,
      {
        result: 'paid',
      },
    );
    await evaluate();

    const fingerprint = async () =>
      (
        await h.sql(
          `SELECT
             (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, '|' ORDER BY a.id), '')) FROM alerts a) AS alerts,
             (SELECT count(*) FROM audit_events) AS audit,
             (SELECT md5(coalesce(string_agg(to_jsonb(o)::text, '|' ORDER BY o.id), '')) FROM obligation_occurrences o) AS occurrences`,
        )
      )[0];
    const before = await fingerprint();
    const [dashboard, attention, alerts] = await Promise.all([
      user.a.get('/dashboard/summary'),
      user.b.get('/attention'),
      user.a.get('/alerts?state=active'),
      ...Array.from({ length: 6 }, () => user.b.get('/dashboard/summary')),
    ]);
    expect(await fingerprint()).toEqual(before);

    expect(dashboard!.body.obligations).toMatchObject({
      periodsPending: 1,
      periodsOverdue: 1,
      periodsConfirmed: 1,
    });
    expect(dashboard!.body.alerts.active).toBe(2);
    expect(alerts!.body.total).toBe(2);
    expect(attention!.body.total).toBe(2);
    const money = dashboard!.body.money.obligationsOpen as {
      total: string;
      count: number;
    }[];
    expect(money[0]).toMatchObject({ total: '2000.00', count: 2 });
  });
});
