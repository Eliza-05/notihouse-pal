import { Harness, statuses } from './support/harness.js';

describe('Confirmaciones financieras e integridad de arriendos en PostgreSQL real', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());

  describe('Escenario I — obligaciones', () => {
    const setup = async () => {
      const user = await h.newUser();
      const obligation = await h.obligation(user);
      const occurrence = await h.occurrence(user, obligation);
      const base = `/obligations/${obligation}/occurrences/${occurrence}`;
      const row = async () =>
        (
          await h.sql(`SELECT * FROM obligation_occurrences WHERE id = $1`, [
            occurrence,
          ])
        )[0]!;
      return { user, occurrence, base, row };
    };

    it('confirmaciones idénticas: una transición, una auditoría', async () => {
      const { user, occurrence, base, row } = await setup();
      const { results } = await h.behindLock(
        'occurrence-identical',
        { table: 'obligation_occurrences', id: occurrence },
        4,
        () =>
          Array.from({ length: 4 }, (_, i) =>
            (i % 2 ? user.a : user.b).post(`${base}/confirm`, {
              result: 'paid',
              reference: 'REF-1',
            }),
          ),
      );
      expect(statuses(results)).toEqual([200, 200, 200, 200]);
      expect(await h.audit('obligation_occurrence.confirm', occurrence)).toBe(
        1,
      );
      const stored = await row();
      expect(stored.status).toBe('paid');
      expect(stored.confirmed_by).toBe(user.profileId);
      expect(stored.confirmation_reference).toBe('REF-1');
    });

    it('`paid` contra `attended`: una decisión, la otra 409', async () => {
      const { user, occurrence, base, row } = await setup();
      const { results } = await h.behindLock(
        'occurrence-paid-vs-attended',
        { table: 'obligation_occurrences', id: occurrence },
        2,
        () => [
          user.a.post(`${base}/confirm`, { result: 'paid' }),
          user.b.post(`${base}/confirm`, { result: 'attended' }),
        ],
      );
      expect(statuses(results)).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      expect((await row()).status).toBe(winner.body.status);
      expect(await h.audit('obligation_occurrence.confirm', occurrence)).toBe(
        1,
      );
    });

    it('confirmar y cancelar a la vez: un único estado definitivo', async () => {
      for (const confirmFirst of [true, false]) {
        const { user, occurrence, base, row } = await setup();
        const calls = [
          () => user.a.post(`${base}/confirm`, { result: 'paid' }),
          () => user.b.patch(base, { status: 'cancelled' }),
        ];
        const { results } = await h.behindLock(
          'occurrence-confirm-vs-cancel',
          { table: 'obligation_occurrences', id: occurrence },
          2,
          () => (confirmFirst ? calls : [...calls].reverse()).map((c) => c()),
        );
        expect(statuses(results)).toEqual([200, 409]);
        const stored = await row();
        expect(['paid', 'cancelled']).toContain(stored.status);
        expect(stored.confirmed_at !== null).toBe(stored.status === 'paid');
        const events =
          (await h.audit('obligation_occurrence.confirm', occurrence)) +
          (await h.audit('obligation_occurrence.update', occurrence));
        expect(events).toBe(1);
      }
    });
  });

  describe('Escenario I — arriendos', () => {
    const setup = async () => {
      const user = await h.newUser();
      const rental = await h.rental(user);
      const charge = await h.charge(user, rental);
      const base = `/rentals/${rental}/charges/${charge}`;
      const row = async () =>
        (await h.sql(`SELECT * FROM rent_charges WHERE id = $1`, [charge]))[0]!;
      return { user, rental, charge, base, row };
    };

    it('evidencia idéntica: una recepción con identidad y hora de PostgreSQL', async () => {
      const { user, charge, base, row } = await setup();
      const before = Date.now();
      const { results } = await h.behindLock(
        'charge-identical',
        { table: 'rent_charges', id: charge },
        4,
        () =>
          Array.from({ length: 4 }, (_, i) =>
            (i % 2 ? user.a : user.b).post(`${base}/confirm`, {
              evidence: 'Transferencia 123',
            }),
          ),
      );
      expect(statuses(results)).toEqual([200, 200, 200, 200]);
      const stored = await row();
      expect(stored.status).toBe('received');
      expect(stored.confirmed_by).toBe(user.profileId);
      expect(stored.confirmation_evidence).toBe('Transferencia 123');
      expect(new Date(stored.confirmed_at).getTime()).toBeGreaterThan(
        before - 60_000,
      );
      expect(await h.audit('rent_charge.confirm', charge)).toBe(1);
      const [event] = await h.sql(
        `SELECT metadata FROM audit_events WHERE action = 'rent_charge.confirm' AND metadata->>'resourceId' = $1`,
        [charge],
      );
      expect(JSON.stringify(event!.metadata)).not.toContain('Transferencia');
    });

    it('evidencia distinta: gana una, la otra 409 y la primera se preserva', async () => {
      const { user, charge, base, row } = await setup();
      const { results } = await h.behindLock(
        'charge-different-evidence',
        { table: 'rent_charges', id: charge },
        2,
        () => [
          user.a.post(`${base}/confirm`, { evidence: 'Primera' }),
          user.b.post(`${base}/confirm`, { evidence: 'Segunda' }),
        ],
      );
      expect(statuses(results)).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      expect((await row()).confirmation_evidence).toBe(
        winner.body.confirmationEvidence,
      );
      expect(await h.audit('rent_charge.confirm', charge)).toBe(1);
    });

    it('confirmar y cancelar a la vez: un único estado definitivo', async () => {
      const { user, charge, base, row } = await setup();
      const { results } = await h.behindLock(
        'charge-confirm-vs-cancel',
        { table: 'rent_charges', id: charge },
        2,
        () => [
          user.a.post(`${base}/confirm`, { evidence: 'Recibido' }),
          user.b.patch(base, { status: 'cancelled' }),
        ],
      );
      expect(statuses(results)).toEqual([200, 409]);
      const stored = await row();
      expect(['received', 'cancelled']).toContain(stored.status);
      expect(stored.confirmed_at !== null).toBe(stored.status === 'received');
    });

    it('el cobro de otro usuario no se confirma, aunque compitan a la vez', async () => {
      const { user, charge, base, row } = await setup();
      const bob = await h.newUser();
      const { results } = await h.behindLock(
        'charge-foreign-vs-owner',
        { table: 'rent_charges', id: charge },
        1,
        () => [
          user.a.post(`${base}/confirm`, { evidence: 'Dueño' }),
          bob.b.post(`${base}/confirm`, { evidence: 'Ajeno' }),
        ],
      );
      expect(results[0]!.status).toBe(200);
      expect(results[1]!.status).toBe(404);
      const stored = await row();
      expect(stored.confirmation_evidence).toBe('Dueño');
      expect(stored.confirmed_by).toBe(user.profileId);
    });

    it('un cobro recibido no admite cambios posteriores', async () => {
      const { user, base, row } = await setup();
      await user.a.post(`${base}/confirm`, { evidence: 'Recibido' });
      const before = await row();
      expect((await user.a.patch(base, { status: 'cancelled' })).status).toBe(
        409,
      );
      expect(
        (await user.a.patch(base, { expectedAmount: '5.00' })).status,
      ).toBe(409);
      expect(await row()).toEqual(before);
    });
  });

  describe('Escenario L — integridad de arriendos', () => {
    const body = (propertyId: string, startsOn: string, endsOn?: string) => ({
      propertyId,
      expectedAmount: '1000.00',
      dueDay: 5,
      startsOn,
      ...(endsOn ? { endsOn } : {}),
    });

    it.each<[string, [string, string?], [string, string?], number]>([
      [
        'fechas iguales',
        ['2030-01-01', '2030-12-31'],
        ['2030-01-01', '2030-12-31'],
        409,
      ],
      [
        'solapamiento parcial',
        ['2030-01-01', '2030-06-30'],
        ['2030-06-01', '2030-12-31'],
        409,
      ],
      [
        'solapamiento total',
        ['2030-01-01', '2030-12-31'],
        ['2030-03-01', '2030-04-30'],
        409,
      ],
      [
        'un mismo día de frontera',
        ['2030-01-01', '2030-06-30'],
        ['2030-06-30', '2030-12-31'],
        409,
      ],
      ['existente sin fin', ['2030-01-01'], ['2035-01-01', '2035-12-31'], 409],
      ['nuevo sin fin', ['2030-06-01', '2030-12-31'], ['2030-01-01'], 409],
      [
        'consecutivos',
        ['2030-01-01', '2030-06-30'],
        ['2030-07-01', '2030-12-31'],
        201,
      ],
      [
        'anterior sin solape',
        ['2031-01-01'],
        ['2030-01-01', '2030-12-31'],
        201,
      ],
    ])('%s', async (_n, first, second, expected) => {
      const user = await h.newUser();
      const property = await h.property(user);
      const a = await user.a.post('/rentals', body(property, ...first));
      expect(a.status).toBe(201);
      const b = await user.a.post('/rentals', body(property, ...second));
      expect(b.status).toBe(expected);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM rentals WHERE property_id = $1`,
          [property],
        ),
      ).toBe(expected === 201 ? 2 : 1);
    });

    it('otros inmuebles y otros propietarios no se consideran', async () => {
      const [alice, bob] = [await h.newUser(), await h.newUser()];
      const dates = ['2030-01-01', '2030-12-31'] as const;
      for (const [user, property] of [
        [alice, await h.property(alice)],
        [alice, await h.property(alice)],
        [bob, await h.property(bob)],
      ] as const) {
        expect(
          (await user.a.post('/rentals', body(property, ...dates))).status,
        ).toBe(201);
      }
    });

    it('un arriendo terminado no ocupa el inmueble', async () => {
      const user = await h.newUser();
      const property = await h.property(user);
      const old = await user.a.post('/rentals', body(property, '2030-01-01'));
      await user.a.patch(`/rentals/${old.body.id}`, { status: 'ended' });
      const next = await user.a.post('/rentals', body(property, '2030-02-01'));
      expect(next.status).toBe(201);
    });

    it('un arriendo suspendido sí ocupa el inmueble', async () => {
      const user = await h.newUser();
      const property = await h.property(user);
      await user.a.post('/rentals', {
        ...body(property, '2030-01-01'),
        status: 'suspended',
      });
      const next = await user.a.post('/rentals', body(property, '2031-01-01'));
      expect(next.status).toBe(409);
    });

    it('editar respeta el intervalo y se excluye a sí mismo', async () => {
      const user = await h.newUser();
      const property = await h.property(user);
      const a = await user.a.post(
        '/rentals',
        body(property, '2030-01-01', '2030-06-30'),
      );
      const b = await user.a.post(
        '/rentals',
        body(property, '2030-07-01', '2030-12-31'),
      );
      // Mover el propio intervalo sin invadir al otro.
      const own = await user.a.patch(`/rentals/${a.body.id}`, {
        startsOn: '2030-02-01',
      });
      expect(own.status).toBe(200);
      const invade = await user.a.patch(`/rentals/${a.body.id}`, {
        endsOn: '2030-07-15',
      });
      expect(invade.status).toBe(409);
      const open = await user.a.patch(`/rentals/${b.body.id}`, {
        startsOn: '2030-06-01',
      });
      expect(open.status).toBe(409);
      const [row] = await h.sql(
        `SELECT ends_on::text FROM rentals WHERE id = $1`,
        [a.body.id],
      );
      expect(row!.ends_on).toBe('2030-06-30');
      // Cambiar otro campo sobre un arriendo sin conflicto sigue funcionando.
      const amount = await user.a.patch(`/rentals/${b.body.id}`, {
        expectedAmount: '1500.00',
      });
      expect(amount.status).toBe(200);
    });

    it('reactivar un arriendo suspendido no comprueba de más ni omite el conflicto', async () => {
      const user = await h.newUser();
      const property = await h.property(user);
      const a = await user.a.post(
        '/rentals',
        body(property, '2030-01-01', '2030-06-30'),
      );
      await user.a.patch(`/rentals/${a.body.id}`, { status: 'suspended' });
      const reactivated = await user.a.patch(`/rentals/${a.body.id}`, {
        status: 'active',
      });
      expect(reactivated.status).toBe(200);
    });

    it('dos creaciones concurrentes solapadas: una sola entra', async () => {
      const user = await h.newUser();
      const property = await h.property(user);
      const { results, blocked } = await h.behindLock(
        'rental-overlap-race',
        { table: 'properties', id: property },
        4,
        () =>
          Array.from({ length: 4 }, (_, i) =>
            (i % 2 ? user.a : user.b).post(
              '/rentals',
              body(property, '2030-01-01', '2030-12-31'),
            ),
          ),
      );
      expect(new Set(blocked.map((b) => b.pid)).size).toBe(4);
      expect(statuses(results)).toEqual([201, 409, 409, 409]);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM rentals WHERE property_id = $1`,
          [property],
        ),
      ).toBe(1);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM rentals r JOIN audit_events a
              ON a.metadata->>'resourceId' = r.id::text AND a.action = 'rental.create'
            WHERE r.property_id = $1`,
          [property],
        ),
      ).toBe(1);
    });

    it('crear y extender a la vez no produce un solapamiento', async () => {
      const user = await h.newUser();
      const property = await h.property(user);
      const a = await user.a.post(
        '/rentals',
        body(property, '2030-01-01', '2030-06-30'),
      );
      const { results } = await h.behindLock(
        'rental-create-vs-extend',
        { table: 'properties', id: property },
        2,
        () => [
          user.a.patch(`/rentals/${a.body.id}`, { endsOn: '2030-12-31' }),
          user.b.post('/rentals', body(property, '2030-07-01', '2030-12-31')),
        ],
      );
      const successes = results.filter((r) => r.status < 300);
      expect(successes).toHaveLength(1);
      const overlaps = await h.count(
        `SELECT count(*) AS n FROM rentals x JOIN rentals y
            ON x.property_id = y.property_id AND x.id < y.id
         WHERE x.property_id = $1
           AND daterange(x.starts_on, x.ends_on, '[]') && daterange(y.starts_on, y.ends_on, '[]')`,
        [property],
      );
      expect(overlaps).toBe(0);
    });
  });
});
