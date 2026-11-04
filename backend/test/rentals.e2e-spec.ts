import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuditService } from '../src/audit/audit.service.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Arriendos, cobros y confirmación manual de recepción sobre PostgreSQL en
 * memoria (PGlite con las migraciones versionadas): reglas de negocio,
 * aislamiento por propietario, idempotencia/concurrencia y auditoría transaccional.
 */
describe('Rentals and rent charges (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let laura: TestUser;
  let andres: TestUser;
  let lauraProperty: string;
  let andresProperty: string;

  const pw = () => randomBytes(12).toString('base64url');
  /** Período de un día distinto en cada llamada (dentro de 2026), para no repetir `periodStart`. */
  let dayIndex = 120;
  const nextPeriod = () => {
    dayIndex += 1;
    const day = new Date(Date.UTC(2026, 0, 1 + dayIndex))
      .toISOString()
      .slice(0, 10);
    return { periodStart: day, periodEnd: day, dueDate: day };
  };
  const uniq = () => randomBytes(4).toString('hex');

  const countAudit = async (action: string, resourceId: string) =>
    Number(
      (
        await t.client.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_events WHERE action = $1 AND metadata->>'resourceId' = $2`,
          [action, resourceId],
        )
      ).rows[0]!.n,
    );

  const countRows = async (table: 'rentals' | 'rent_charges') =>
    Number(
      (
        await t.client.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table}`,
        )
      ).rows[0]!.n,
    );

  const newProperty = async (user: TestUser) =>
    (
      await h
        .as(user)
        .post('/properties', { name: `Inmueble ${uniq()}` })
        .expect(201)
    ).body.id as string;

  const newRental = async (
    user: TestUser,
    propertyId: string,
    body: object = {},
  ) =>
    (
      await h
        .as(user)
        .post('/rentals', {
          propertyId,
          tenantAlias: 'Arrendatario ficticio',
          expectedAmount: '950000.00',
          dueDay: 5,
          startsOn: '2026-01-01',
          endsOn: '2026-12-31',
          ...body,
        })
        .expect(201)
    ).body as { id: string; expectedAmount: string; status: string };

  const newCharge = async (
    user: TestUser,
    rentalId: string,
    body: object = {},
  ) =>
    (
      await h
        .as(user)
        .post(`/rentals/${rentalId}/charges`, {
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          dueDate: '2026-11-05',
          ...body,
        })
        .expect(201)
    ).body as {
      id: string;
      status: string;
      expectedAmount: string;
      confirmedAt: string | null;
    };

  beforeAll(async () => {
    t = await createMigratedDatabase();
    laura = await createTestUser(t.db, {
      email: 'laura@notihouse.test',
      password: pw(),
      displayName: 'Laura',
    });
    andres = await createTestUser(t.db, {
      email: 'andres@notihouse.test',
      password: pw(),
      displayName: 'Andrés',
    });
    h = await createTestApp(t.db);
    lauraProperty = await newProperty(laura);
    andresProperty = await newProperty(andres);
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
    await t.client.close();
  });

  describe('authentication', () => {
    it.each([
      ['get', '/api/v1/rentals'],
      ['get', `/api/v1/rentals/${randomUUID()}`],
      ['post', '/api/v1/rentals'],
      ['patch', `/api/v1/rentals/${randomUUID()}`],
      ['get', `/api/v1/rentals/${randomUUID()}/charges`],
      ['post', `/api/v1/rentals/${randomUUID()}/charges`],
      ['patch', `/api/v1/rentals/${randomUUID()}/charges/${randomUUID()}`],
      [
        'post',
        `/api/v1/rentals/${randomUUID()}/charges/${randomUUID()}/confirm`,
      ],
    ] as const)('%s %s requires a valid JWT', async (method, path) => {
      const server = h.app.getHttpServer();
      await request(server)[method](path).send({}).expect(401);
      await request(server)
        [method](path)
        .set('Authorization', 'Bearer not-a-jwt')
        .send({})
        .expect(401);
    });

    it('does not expose DELETE routes', async () => {
      const own = await newRental(laura, await newProperty(laura));
      const auth = `Bearer ${h.tokenFor(laura)}`;
      await request(h.app.getHttpServer())
        .delete(`/api/v1/rentals/${own.id}`)
        .set('Authorization', auth)
        .expect(404);
      await h.as(laura).get(`/rentals/${own.id}`).expect(200);
    });
  });

  describe('rentals', () => {
    it('creates a rental with defaults, audits it and propagates the correlation id', async () => {
      const correlationId = randomUUID();
      const res = await h
        .as(andres)
        .post('/rentals', {
          propertyId: andresProperty,
          expectedAmount: '950000',
          dueDay: 5,
          startsOn: '2026-01-01',
        })
        .set('X-Correlation-Id', correlationId)
        .expect(201);
      expect(res.headers['x-correlation-id']).toBe(correlationId);
      expect(res.body).toMatchObject({
        propertyId: andresProperty,
        tenantAlias: null,
        expectedAmount: '950000.00',
        currency: 'COP',
        dueDay: 5,
        startsOn: '2026-01-01',
        endsOn: null,
        status: 'active',
      });
      expect(res.body).not.toHaveProperty('ownerId');

      const audit = await t.client.query<Record<string, unknown>>(
        `SELECT * FROM audit_events WHERE action = 'rental.create' AND metadata->>'resourceId' = $1`,
        [res.body.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        actor_type: 'user',
        actor_id: andres.profileId,
        owner_id: andres.profileId,
        component: 'api.rentals',
        result: 'success',
        correlation_id: correlationId,
      });
    });

    it('rejects foreign, nonexistent and inactive properties without writing', async () => {
      const before = await countRows('rentals');
      const foreign = await h
        .as(laura)
        .post('/rentals', {
          propertyId: andresProperty,
          expectedAmount: '950000.00',
          dueDay: 5,
          startsOn: '2026-01-01',
        })
        .expect(404);
      expect(foreign.body.message).toBe('Inmueble no encontrado');
      await h
        .as(laura)
        .post('/rentals', {
          propertyId: randomUUID(),
          expectedAmount: '950000.00',
          dueDay: 5,
          startsOn: '2026-01-01',
        })
        .expect(404);

      const inactive = await newProperty(laura);
      await h
        .as(laura)
        .patch(`/properties/${inactive}`, { status: 'inactive' })
        .expect(200);
      await h
        .as(laura)
        .post('/rentals', {
          propertyId: inactive,
          expectedAmount: '950000.00',
          dueDay: 5,
          startsOn: '2026-01-01',
        })
        .expect(409);
      expect(await countRows('rentals')).toBe(before);
    });

    it.each([
      ['negative amount', { expectedAmount: '-950000' }],
      ['zero amount', { expectedAmount: '0.00' }],
      ['numeric amount', { expectedAmount: 950000 }],
      ['three decimals', { expectedAmount: '950000.123' }],
      ['amount too large', { expectedAmount: '1234567890123' }],
      ['impossible start date', { startsOn: '2026-02-30' }],
      ['wrong date format', { startsOn: '01/01/2026' }],
      ['end before start', { startsOn: '2026-06-01', endsOn: '2026-05-31' }],
      ['due day 0', { dueDay: 0 }],
      ['due day 32', { dueDay: 32 }],
      ['ended on creation', { status: 'ended' }],
      ['unknown status', { status: 'paused' }],
      ['lowercase currency', { currency: 'cop' }],
      ['client-chosen owner', { ownerId: randomUUID() }],
      ['client-chosen creator', { createdBy: randomUUID() }],
      ['missing property', { propertyId: undefined }],
      ['malformed property id', { propertyId: 'abc' }],
    ])('rejects invalid input (%s) with 400', async (_case, override) => {
      const before = await countRows('rentals');
      await h
        .as(laura)
        .post('/rentals', {
          propertyId: lauraProperty,
          expectedAmount: '950000.00',
          dueDay: 5,
          startsOn: '2026-01-01',
          ...override,
        })
        .expect(400);
      expect(await countRows('rentals')).toBe(before);
    });

    it('returns own rentals and hides foreign or nonexistent ones (404)', async () => {
      const own = await newRental(andres, await newProperty(andres));
      expect(
        (await h.as(andres).get(`/rentals/${own.id}`).expect(200)).body.id,
      ).toBe(own.id);

      const foreign = await h.as(laura).get(`/rentals/${own.id}`).expect(404);
      expect(foreign.body.message).toBe('Arriendo no encontrado');
      expect(JSON.stringify(foreign.body)).not.toContain(own.id);
      await h.as(andres).get(`/rentals/${randomUUID()}`).expect(404);
      await h.as(andres).get('/rentals/not-a-uuid').expect(400);
    });

    it('rejects overlapping rentals on one property and allows consecutive ones', async () => {
      const property = await newProperty(andres);
      const body = (startsOn: string, endsOn?: string) => ({
        propertyId: property,
        expectedAmount: '950000.00',
        dueDay: 5,
        startsOn,
        ...(endsOn ? { endsOn } : {}),
      });
      const first = await h
        .as(andres)
        .post('/rentals', body('2030-01-01', '2030-06-30'))
        .expect(201);
      await h
        .as(andres)
        .post('/rentals', body('2030-06-30', '2030-12-31'))
        .expect(409);
      await h.as(andres).post('/rentals', body('2030-03-01')).expect(409);
      const next = await h
        .as(andres)
        .post('/rentals', body('2030-07-01', '2030-12-31'))
        .expect(201);
      await h
        .as(andres)
        .patch(`/rentals/${first.body.id}`, { endsOn: '2030-07-01' })
        .expect(409);
      // Un arriendo terminado deja libre el inmueble.
      await h
        .as(andres)
        .patch(`/rentals/${next.body.id}`, { status: 'ended' })
        .expect(200);
      await h
        .as(andres)
        .patch(`/rentals/${first.body.id}`, { endsOn: '2030-07-01' })
        .expect(200);
    });

    it('lists only own rentals with pagination and filters', async () => {
      const user = await createTestUser(t.db, {
        email: `list-${uniq()}@notihouse.test`,
        password: pw(),
        displayName: 'Listados',
      });
      const p1 = await newProperty(user);
      const p2 = await newProperty(user);
      const r1 = await newRental(user, p1);
      const r2 = await newRental(user, p1, {
        status: 'suspended',
        startsOn: '2027-01-01',
        endsOn: '2027-12-31',
      });
      const r3 = await newRental(user, p2);

      const all = (await h.as(user).get('/rentals').expect(200)).body;
      expect(all.total).toBe(3);
      expect(all.items.map((r: { id: string }) => r.id)).toEqual([
        r1.id,
        r2.id,
        r3.id,
      ]);

      const page2 = (
        await h.as(user).get('/rentals?page=2&pageSize=2').expect(200)
      ).body;
      expect(page2).toMatchObject({ page: 2, pageSize: 2, total: 3 });
      expect(page2.items.map((r: { id: string }) => r.id)).toEqual([r3.id]);

      const byProperty = (
        await h.as(user).get(`/rentals?propertyId=${p1}`).expect(200)
      ).body;
      expect(byProperty.total).toBe(2);
      const suspended = (
        await h.as(user).get('/rentals?status=suspended').expect(200)
      ).body;
      expect(suspended.items.map((r: { id: string }) => r.id)).toEqual([r2.id]);

      // Filtrar por un inmueble ajeno no revela nada.
      const foreign = (
        await h
          .as(user)
          .get(`/rentals?propertyId=${andresProperty}`)
          .expect(200)
      ).body;
      expect(foreign).toMatchObject({ items: [], total: 0 });

      await h.as(user).get('/rentals?pageSize=101').expect(400);
      await h.as(user).get('/rentals?status=paused').expect(400);
      await h.as(user).get('/rentals?propertyId=abc').expect(400);
    });

    it('updates allowed fields, audits the change and skips no-op patches', async () => {
      const own = await newRental(laura, await newProperty(laura));
      const res = await h
        .as(laura)
        .patch(`/rentals/${own.id}`, {
          tenantAlias: 'Nuevo alias',
          dueDay: 10,
          endsOn: null,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        tenantAlias: 'Nuevo alias',
        dueDay: 10,
        endsOn: null,
      });
      expect(await countAudit('rental.update', own.id)).toBe(1);

      await h.as(laura).patch(`/rentals/${own.id}`, { dueDay: 10 }).expect(200);
      expect(await countAudit('rental.update', own.id)).toBe(1);
      await h.as(laura).patch(`/rentals/${own.id}`, {}).expect(400);
    });

    it.each([
      ['owner', { ownerId: randomUUID() }],
      ['property', { propertyId: randomUUID() }],
      ['currency', { currency: 'USD' }],
      ['null amount', { expectedAmount: null }],
      ['zero amount', { expectedAmount: '0' }],
      ['end before start', { endsOn: '2025-12-31' }],
      ['unknown status', { status: 'paused' }],
    ])('rejects a PATCH that changes %s (400)', async (_case, body) => {
      const property = await newProperty(laura);
      const own = await newRental(laura, property);
      await h.as(laura).patch(`/rentals/${own.id}`, body).expect(400);
      expect(
        (await h.as(laura).get(`/rentals/${own.id}`).expect(200)).body,
      ).toMatchObject({
        propertyId: property,
        currency: 'COP',
        expectedAmount: '950000.00',
        status: 'active',
      });
    });

    it('does not let a user edit a foreign rental (404, unchanged)', async () => {
      const own = await newRental(andres, await newProperty(andres));
      await h
        .as(laura)
        .patch(`/rentals/${own.id}`, { expectedAmount: '1.00' })
        .expect(404);
      expect(
        (await h.as(andres).get(`/rentals/${own.id}`).expect(200)).body
          .expectedAmount,
      ).toBe('950000.00');
    });

    it('keeps the historical amount of existing charges when the rent changes', async () => {
      const own = await newRental(andres, await newProperty(andres));
      const charge = await newCharge(andres, own.id);
      await h
        .as(andres)
        .patch(`/rentals/${own.id}`, { expectedAmount: '1000000.00' })
        .expect(200);

      expect(
        (
          await h
            .as(andres)
            .get(`/rentals/${own.id}/charges/${charge.id}`)
            .expect(200)
        ).body.expectedAmount,
      ).toBe('950000.00');
      const next = await newCharge(andres, own.id, {
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-12-05',
      });
      expect(next.expectedAmount).toBe('1000000.00');
    });

    it('supports active ↔ suspended → ended, and ended is final', async () => {
      const own = await newRental(laura, await newProperty(laura));
      const path = `/rentals/${own.id}`;
      await h.as(laura).patch(path, { status: 'suspended' }).expect(200);
      await h.as(laura).patch(path, { status: 'active' }).expect(200);
      const ended = await h
        .as(laura)
        .patch(path, { status: 'ended' })
        .expect(200);
      expect(ended.body.status).toBe('ended');

      await h.as(laura).patch(path, { status: 'active' }).expect(409);
      await h.as(laura).patch(path, { tenantAlias: 'X' }).expect(409);
      await h
        .as(laura)
        .post(`${path}/charges`, {
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          dueDate: '2026-11-05',
        })
        .expect(409);
      expect(await countAudit('rental.update', own.id)).toBe(3);
    });
  });

  describe('rent charges', () => {
    let rental: { id: string };

    beforeAll(async () => {
      rental = await newRental(andres, await newProperty(andres));
    });

    it('creates an expected charge copying amount and currency, and audits it', async () => {
      const charge = (
        await h
          .as(andres)
          .post(`/rentals/${rental.id}/charges`, {
            periodStart: '2026-02-01',
            periodEnd: '2026-02-28',
            dueDate: '2026-02-05',
          })
          .expect(201)
      ).body;
      expect(charge).toMatchObject({
        rentalId: rental.id,
        expectedAmount: '950000.00',
        currency: 'COP',
        status: 'expected',
        confirmedAt: null,
        confirmedBy: null,
        confirmationEvidence: null,
      });
      expect(charge).not.toHaveProperty('ownerId');
      expect(await countAudit('rent_charge.create', charge.id)).toBe(1);
    });

    it('accepts an explicit exact amount', async () => {
      const charge = await newCharge(andres, rental.id, {
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        dueDate: '2026-03-05',
        expectedAmount: '475000.50',
      });
      expect(charge.expectedAmount).toBe('475000.50');
    });

    it('rejects a duplicate period for the same rental (409)', async () => {
      const body = {
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        dueDate: '2026-04-05',
      };
      await newCharge(andres, rental.id, body);
      const res = await h
        .as(andres)
        .post(`/rentals/${rental.id}/charges`, body)
        .expect(409);
      expect(res.body.message).toBe(
        'Ya existe un cobro con esa fecha de inicio de período para este arriendo',
      );
    });

    it.each([
      ['negative amount', { expectedAmount: '-1' }],
      ['zero amount', { expectedAmount: '0' }],
      ['numeric amount', { expectedAmount: 950000 }],
      ['end before start', { periodEnd: '2026-04-30' }],
      ['impossible date', { dueDate: '2026-06-31' }],
      ['missing due date', { dueDate: undefined }],
      [
        'period before the rental',
        { periodStart: '2025-12-01', periodEnd: '2025-12-31' },
      ],
      [
        'period after the rental',
        { periodStart: '2027-01-01', periodEnd: '2027-01-31' },
      ],
      ['received on creation', { status: 'received' }],
      ['client confirmation', { confirmedBy: randomUUID() }],
      ['client owner', { ownerId: randomUUID() }],
    ])(
      'rejects invalid charge input (%s) with 400',
      async (_case, override) => {
        const before = await countRows('rent_charges');
        await h
          .as(andres)
          .post(`/rentals/${rental.id}/charges`, {
            periodStart: '2026-05-01',
            periodEnd: '2026-05-31',
            dueDate: '2026-05-05',
            ...override,
          })
          .expect(400);
        expect(await countRows('rent_charges')).toBe(before);
      },
    );

    it('lists charges ordered by due date, with filters and pagination', async () => {
      const own = await newRental(andres, await newProperty(andres));
      const dec = await newCharge(andres, own.id, {
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-12-05',
      });
      const oct = await newCharge(andres, own.id, {
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        dueDate: '2026-10-05',
      });
      const nov = await newCharge(andres, own.id);
      await h
        .as(andres)
        .patch(`/rentals/${own.id}/charges/${dec.id}`, { status: 'cancelled' })
        .expect(200);

      const ids = (body: { items: { id: string }[] }) =>
        body.items.map((c) => c.id);
      const path = `/rentals/${own.id}/charges`;
      const all = (await h.as(andres).get(path).expect(200)).body;
      expect(all.total).toBe(3);
      expect(ids(all)).toEqual([oct.id, nov.id, dec.id]);

      expect(
        ids(
          (await h.as(andres).get(`${path}?status=expected`).expect(200)).body,
        ),
      ).toEqual([oct.id, nov.id]);
      expect(
        ids(
          (
            await h
              .as(andres)
              .get(`${path}?periodFrom=2026-11-01&periodTo=2026-12-31`)
              .expect(200)
          ).body,
        ),
      ).toEqual([nov.id, dec.id]);
      const page = (
        await h.as(andres).get(`${path}?page=2&pageSize=1`).expect(200)
      ).body;
      expect(ids(page)).toEqual([nov.id]);

      await h.as(andres).get(`${path}?status=paid`).expect(400);
      await h.as(andres).get(`${path}?periodFrom=2026-02-30`).expect(400);
    });

    it('hides foreign charges and requires the exact rental/charge pair', async () => {
      const charge = await newCharge(andres, rental.id, {
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        dueDate: '2026-06-05',
      });
      const path = `/rentals/${rental.id}/charges/${charge.id}`;
      await h.as(andres).get(path).expect(200);

      // Laura conoce los UUID de Andrés, pero no puede ver nada.
      await h.as(laura).get(path).expect(404);
      await h.as(laura).get(`/rentals/${rental.id}/charges`).expect(404);
      await h
        .as(laura)
        .post(`/rentals/${rental.id}/charges`, {
          periodStart: '2026-07-01',
          periodEnd: '2026-07-31',
          dueDate: '2026-07-05',
        })
        .expect(404);
      await h.as(laura).patch(path, { expectedAmount: '1.00' }).expect(404);

      // Cobro propio, pero consultado a través de otro arriendo propio.
      const other = await newRental(andres, await newProperty(andres));
      await h
        .as(andres)
        .get(`/rentals/${other.id}/charges/${charge.id}`)
        .expect(404);
      await h
        .as(andres)
        .patch(`/rentals/${other.id}/charges/${charge.id}`, {
          dueDate: '2026-06-06',
        })
        .expect(404);
      expect((await h.as(andres).get(path).expect(200)).body).toMatchObject({
        expectedAmount: '950000.00',
        dueDate: '2026-06-05',
      });
    });

    it('edits an open charge and audits it', async () => {
      const charge = await newCharge(andres, rental.id, {
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        dueDate: '2026-07-05',
      });
      const res = await h
        .as(andres)
        .patch(`/rentals/${rental.id}/charges/${charge.id}`, {
          dueDate: '2026-07-10',
          expectedAmount: '900000.00',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        dueDate: '2026-07-10',
        expectedAmount: '900000.00',
        status: 'expected',
      });
      expect(await countAudit('rent_charge.update', charge.id)).toBe(1);
    });

    it.each([
      ['status received', { status: 'received' }],
      ['status pending', { status: 'pending' }],
      ['confirmedAt', { confirmedAt: '2026-07-05T00:00:00Z' }],
      ['confirmedBy', { confirmedBy: randomUUID() }],
      ['confirmationEvidence', { confirmationEvidence: 'x' }],
      ['rentalId', { rentalId: randomUUID() }],
      ['ownerId', { ownerId: randomUUID() }],
      ['currency', { currency: 'USD' }],
      [
        'period end before start',
        { periodStart: '2026-10-10', periodEnd: '2026-10-09' },
      ],
    ])('rejects a charge PATCH with %s (400)', async (_case, body) => {
      const charge = await newCharge(andres, rental.id, nextPeriod());
      await h
        .as(andres)
        .patch(`/rentals/${rental.id}/charges/${charge.id}`, body)
        .expect(400);
      expect(
        (
          await h
            .as(andres)
            .get(`/rentals/${rental.id}/charges/${charge.id}`)
            .expect(200)
        ).body,
      ).toMatchObject({ status: 'expected', confirmedAt: null });
    });

    it('cancels without deleting; cancelled and received charges are immutable', async () => {
      const cancelled = await newCharge(andres, rental.id, {
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        dueDate: '2026-09-05',
      });
      const cpath = `/rentals/${rental.id}/charges/${cancelled.id}`;
      await h.as(andres).patch(cpath, { status: 'cancelled' }).expect(200);
      await h.as(andres).patch(cpath, { dueDate: '2026-09-06' }).expect(409);
      expect((await h.as(andres).get(cpath).expect(200)).body.status).toBe(
        'cancelled',
      );

      const received = await newCharge(andres, rental.id, {
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        dueDate: '2026-10-05',
      });
      const rpath = `/rentals/${rental.id}/charges/${received.id}`;
      await h
        .as(andres)
        .post(`${rpath}/confirm`, { evidence: 'Transferencia ficticia 1' })
        .expect(200);
      await h.as(andres).patch(rpath, { expectedAmount: '1.00' }).expect(409);
      await h.as(andres).patch(rpath, { status: 'cancelled' }).expect(409);
      expect((await h.as(andres).get(rpath).expect(200)).body).toMatchObject({
        status: 'received',
        expectedAmount: '950000.00',
      });
    });

    it('never marks a charge as received because its due date passed', async () => {
      const charge = await newCharge(andres, rental.id, {
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        dueDate: '2026-01-05',
      });
      await h.as(andres).get(`/rentals/${rental.id}/charges`).expect(200);
      expect(
        (
          await h
            .as(andres)
            .get(`/rentals/${rental.id}/charges/${charge.id}`)
            .expect(200)
        ).body,
      ).toMatchObject({
        status: 'expected',
        confirmedAt: null,
        confirmedBy: null,
      });
    });
  });

  describe('manual confirmation', () => {
    let rental: { id: string };

    /** Cobro nuevo en un período distinto para cada prueba. */
    const freshCharge = () => newCharge(andres, rental.id, nextPeriod());

    beforeAll(async () => {
      rental = await newRental(andres, await newProperty(andres));
    });

    it('records the human confirmation with server identity, time and evidence', async () => {
      const charge = await freshCharge();
      const correlationId = randomUUID();
      const before = Date.now();
      const res = await h
        .as(andres)
        .post(`/rentals/${rental.id}/charges/${charge.id}/confirm`, {
          evidence: '  Transferencia ficticia 0001  ',
        })
        .set('X-Correlation-Id', correlationId)
        .expect(200);
      const after = Date.now();

      expect(res.body).toMatchObject({
        status: 'received',
        confirmedBy: andres.profileId,
        confirmationEvidence: 'Transferencia ficticia 0001',
      });
      const confirmedAt = new Date(res.body.confirmedAt).getTime();
      expect(confirmedAt).toBeGreaterThanOrEqual(before - 5_000);
      expect(confirmedAt).toBeLessThanOrEqual(after + 5_000);

      const audit = await t.client.query<{ metadata: Record<string, unknown> }>(
        `SELECT * FROM audit_events WHERE action = 'rent_charge.confirm' AND metadata->>'resourceId' = $1`,
        [charge.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        actor_type: 'user',
        actor_id: andres.profileId,
        owner_id: andres.profileId,
        component: 'api.rent-charges',
        correlation_id: correlationId,
      });
      expect(audit.rows[0]!.metadata).toMatchObject({
        rentalId: rental.id,
        humanConfirmation: true,
        statusFrom: 'expected',
        statusTo: 'received',
        hasEvidence: true,
      });
      // La evidencia queda en el cobro, no se copia a la auditoría.
      expect(JSON.stringify(audit.rows[0])).not.toContain('Transferencia');
    });

    it.each([
      ['missing evidence', {}],
      ['blank evidence', { evidence: '   ' }],
      ['numeric evidence', { evidence: 123 }],
      ['evidence too long', { evidence: 'x'.repeat(501) }],
      ['client identity', { evidence: 'ok', confirmedBy: randomUUID() }],
      [
        'client timestamp',
        { evidence: 'ok', confirmedAt: '2020-01-01T00:00:00Z' },
      ],
      ['client status', { evidence: 'ok', status: 'received' }],
    ])(
      'rejects a confirmation with %s (400) and leaves the charge open',
      async (_case, body) => {
        const charge = await freshCharge();
        const path = `/rentals/${rental.id}/charges/${charge.id}`;
        await h.as(andres).post(`${path}/confirm`, body).expect(400);
        expect((await h.as(andres).get(path).expect(200)).body).toMatchObject({
          status: 'expected',
          confirmedAt: null,
          confirmedBy: null,
          confirmationEvidence: null,
        });
        expect(await countAudit('rent_charge.confirm', charge.id)).toBe(0);
      },
    );

    it('does not let another user confirm (404) or a mismatched rental confirm', async () => {
      const charge = await freshCharge();
      const path = `/rentals/${rental.id}/charges/${charge.id}`;
      await h
        .as(laura)
        .post(`${path}/confirm`, { evidence: 'Intento ajeno' })
        .expect(404);
      const other = await newRental(andres, await newProperty(andres));
      await h
        .as(andres)
        .post(`/rentals/${other.id}/charges/${charge.id}/confirm`, {
          evidence: 'Arriendo equivocado',
        })
        .expect(404);
      expect((await h.as(andres).get(path).expect(200)).body.status).toBe(
        'expected',
      );
      expect(await countAudit('rent_charge.confirm', charge.id)).toBe(0);
    });

    it('is idempotent for an identical confirmation and rejects a contradictory one', async () => {
      const charge = await freshCharge();
      const path = `/rentals/${rental.id}/charges/${charge.id}/confirm`;
      const first = await h
        .as(andres)
        .post(path, { evidence: 'Efectivo ficticio' })
        .expect(200);
      const again = await h
        .as(andres)
        .post(path, { evidence: 'Efectivo ficticio' })
        .expect(200);
      expect(again.body.confirmedAt).toBe(first.body.confirmedAt);
      expect(again.body.updatedAt).toBe(first.body.updatedAt);

      const contradictory = await h
        .as(andres)
        .post(path, { evidence: 'Otra evidencia' })
        .expect(409);
      expect(contradictory.body.message).toBe(
        'El cobro ya fue confirmado como recibido con otra evidencia',
      );
      expect(await countAudit('rent_charge.confirm', charge.id)).toBe(1);
    });

    it('rejects confirming a cancelled charge (409)', async () => {
      const charge = await freshCharge();
      const path = `/rentals/${rental.id}/charges/${charge.id}`;
      await h.as(andres).patch(path, { status: 'cancelled' }).expect(200);
      await h
        .as(andres)
        .post(`${path}/confirm`, { evidence: 'Ficticia' })
        .expect(409);
      expect((await h.as(andres).get(path).expect(200)).body.status).toBe(
        'cancelled',
      );
    });

    it('confirms only the requested charge', async () => {
      const a = await freshCharge();
      const b = await freshCharge();
      await h
        .as(andres)
        .post(`/rentals/${rental.id}/charges/${a.id}/confirm`, {
          evidence: 'Solo A',
        })
        .expect(200);
      expect(
        (
          await h
            .as(andres)
            .get(`/rentals/${rental.id}/charges/${b.id}`)
            .expect(200)
        ).body.status,
      ).toBe('expected');
    });

    it('records a single transition for concurrent identical confirmations', async () => {
      const charge = await freshCharge();
      const path = `/rentals/${rental.id}/charges/${charge.id}/confirm`;
      const responses = await Promise.all([
        h.as(andres).post(path, { evidence: 'Doble clic' }),
        h.as(andres).post(path, { evidence: 'Doble clic' }),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      expect(responses[0]!.body.confirmedAt).toBe(
        responses[1]!.body.confirmedAt,
      );
      expect(await countAudit('rent_charge.confirm', charge.id)).toBe(1);
    });

    it('lets only one of two concurrent contradictory confirmations win', async () => {
      const charge = await freshCharge();
      const path = `/rentals/${rental.id}/charges/${charge.id}`;
      const responses = await Promise.all([
        h.as(andres).post(`${path}/confirm`, { evidence: 'Evidencia A' }),
        h.as(andres).post(`${path}/confirm`, { evidence: 'Evidencia B' }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = responses.find((r) => r.status === 200)!.body;
      expect(
        (await h.as(andres).get(path).expect(200)).body.confirmationEvidence,
      ).toBe(winner.confirmationEvidence);
      expect(await countAudit('rent_charge.confirm', charge.id)).toBe(1);
    });
  });

  describe('transactional audit', () => {
    let failing: TestApp;

    beforeAll(async () => {
      // Misma base, pero la auditoría falla: ninguna escritura debe quedar aplicada.
      failing = await createTestApp(t.db, (b) =>
        b.overrideProvider(AuditService).useValue({
          recordUserAction: () =>
            Promise.reject(new Error('audit storage unavailable')),
        }),
      );
    });

    afterAll(async () => {
      await failing.app.close();
    });

    it('rolls back rental creation and update when auditing fails', async () => {
      const before = await countRows('rentals');
      await failing
        .as(laura)
        .post('/rentals', {
          propertyId: await newProperty(laura),
          expectedAmount: '950000.00',
          dueDay: 5,
          startsOn: '2026-01-01',
        })
        .expect(500);
      expect(await countRows('rentals')).toBe(before);

      const own = await newRental(laura, await newProperty(laura));
      await failing
        .as(laura)
        .patch(`/rentals/${own.id}`, { expectedAmount: '1.00' })
        .expect(500);
      expect(
        (await h.as(laura).get(`/rentals/${own.id}`).expect(200)).body
          .expectedAmount,
      ).toBe('950000.00');
    });

    it('rolls back charge creation, update and confirmation when auditing fails', async () => {
      const own = await newRental(laura, await newProperty(laura));
      const before = await countRows('rent_charges');
      await failing
        .as(laura)
        .post(`/rentals/${own.id}/charges`, {
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          dueDate: '2026-11-05',
        })
        .expect(500);
      expect(await countRows('rent_charges')).toBe(before);

      const charge = await newCharge(laura, own.id);
      const path = `/rentals/${own.id}/charges/${charge.id}`;
      await failing
        .as(laura)
        .patch(path, { dueDate: '2026-11-09' })
        .expect(500);
      await failing
        .as(laura)
        .post(`${path}/confirm`, { evidence: 'Debe revertirse' })
        .expect(500);
      expect((await h.as(laura).get(path).expect(200)).body).toMatchObject({
        dueDate: '2026-11-05',
        status: 'expected',
        confirmedAt: null,
        confirmedBy: null,
        confirmationEvidence: null,
      });
    });

    it('keeps audit events append-only', async () => {
      const own = await newRental(laura, await newProperty(laura));
      await expect(
        t.client.query(
          `UPDATE audit_events SET action = 'tampered' WHERE metadata->>'resourceId' = $1`,
          [own.id],
        ),
      ).rejects.toThrow();
      await expect(
        t.client.query(
          `DELETE FROM audit_events WHERE metadata->>'resourceId' = $1`,
          [own.id],
        ),
      ).rejects.toThrow();
      expect(await countAudit('rental.create', own.id)).toBe(1);
    });
  });
});
