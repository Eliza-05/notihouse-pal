import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuditService } from '../src/audit/audit.service.js';
import * as schema from '../src/database/schema/index.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Metadatos de contratos sobre PostgreSQL en memoria: coherencia inmueble /
 * arriendo / documento, aislamiento por propietario, ausencia de renovación o
 * vencimiento automático y auditoría transaccional.
 */
describe('Contracts (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let andres: TestUser;
  let camila: TestUser;
  let camilaProperty: string;
  let camilaRental: string;
  let andresProperty: string;
  let andresRental: string;

  const pw = () => randomBytes(12).toString('base64url');
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

  const countContracts = async () =>
    Number(
      (
        await t.client.query<{ n: string }>(
          'SELECT count(*) AS n FROM contracts',
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

  const newRental = async (user: TestUser, propertyId: string) =>
    (
      await h
        .as(user)
        .post('/rentals', {
          propertyId,
          expectedAmount: '2500000.00',
          dueDay: 16,
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
        })
        .expect(201)
    ).body.id as string;

  const newContract = async (user: TestUser, body: object) =>
    (
      await h
        .as(user)
        .post('/contracts', {
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
          ...body,
        })
        .expect(201)
    ).body as { id: string; status: string; endsOn: string };

  /** El almacenamiento documental aún no existe: el documento se registra directamente. */
  const newDocument = async (
    user: TestUser,
    type: 'contract' | 'invoice' = 'contract',
  ) =>
    (
      await t.db
        .insert(schema.documents)
        .values({
          ownerId: user.profileId,
          type,
          source: 'form',
          mimeType: 'application/pdf',
          storageKey: `test/${uniq()}.pdf`,
        })
        .returning({ id: schema.documents.id })
    )[0]!.id;

  beforeAll(async () => {
    t = await createMigratedDatabase();
    andres = await createTestUser(t.db, {
      email: 'andres@notihouse.test',
      password: pw(),
      displayName: 'Andrés',
    });
    camila = await createTestUser(t.db, {
      email: 'camila@notihouse.test',
      password: pw(),
      displayName: 'Camila',
    });
    h = await createTestApp(t.db);
    camilaProperty = await newProperty(camila);
    camilaRental = await newRental(camila, camilaProperty);
    andresProperty = await newProperty(andres);
    andresRental = await newRental(andres, andresProperty);
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
    await t.client.close();
  });

  it.each([
    ['get', '/api/v1/contracts'],
    ['get', `/api/v1/contracts/${randomUUID()}`],
    ['post', '/api/v1/contracts'],
    ['patch', `/api/v1/contracts/${randomUUID()}`],
  ] as const)('%s %s requires a valid JWT', async (method, path) => {
    const server = h.app.getHttpServer();
    await request(server)[method](path).send({}).expect(401);
    await request(server)
      [method](path)
      .set('Authorization', 'Bearer not-a-jwt')
      .send({})
      .expect(401);
  });

  describe('creation', () => {
    it('creates an active contract linked to an own rental and audits it', async () => {
      const correlationId = randomUUID();
      const res = await h
        .as(camila)
        .post('/contracts', {
          propertyId: camilaProperty,
          rentalId: camilaRental,
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
          noticePeriodDays: 30,
        })
        .set('X-Correlation-Id', correlationId)
        .expect(201);
      expect(res.body).toMatchObject({
        propertyId: camilaProperty,
        rentalId: camilaRental,
        startsOn: '2025-12-16',
        endsOn: '2026-12-15',
        noticePeriodDays: 30,
        status: 'active',
        documentId: null,
      });
      expect(res.body).not.toHaveProperty('ownerId');

      const audit = await t.client.query<Record<string, unknown>>(
        `SELECT * FROM audit_events WHERE action = 'contract.create' AND metadata->>'resourceId' = $1`,
        [res.body.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        actor_id: camila.profileId,
        owner_id: camila.profileId,
        component: 'api.contracts',
        correlation_id: correlationId,
      });
    });

    it('creates a contract without rental and with an own contract document', async () => {
      const documentId = await newDocument(camila);
      const res = await newContract(camila, {
        propertyId: camilaProperty,
        documentId,
      });
      expect(res).toMatchObject({ rentalId: null, documentId });
    });

    it('rejects a missing end date with a clear explanation', async () => {
      const before = await countContracts();
      const res = await h
        .as(camila)
        .post('/contracts', {
          propertyId: camilaProperty,
          startsOn: '2026-01-01',
        })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toContain(
        'endsOn es obligatoria',
      );
      await h
        .as(camila)
        .post('/contracts', {
          propertyId: camilaProperty,
          startsOn: '2026-01-01',
          endsOn: null,
        })
        .expect(400);
      expect(await countContracts()).toBe(before);
    });

    it.each([
      ['end before start', { startsOn: '2026-06-01', endsOn: '2026-05-31' }],
      ['impossible date', { endsOn: '2026-11-31' }],
      ['wrong date format', { startsOn: '2026-1-1' }],
      ['notice period out of range', { noticePeriodDays: 366 }],
      ['negative notice period', { noticePeriodDays: -1 }],
      ['client status', { status: 'expired' }],
      ['client owner', { ownerId: randomUUID() }],
      ['malformed rental id', { rentalId: 'abc' }],
    ])('rejects invalid input (%s) with 400', async (_case, override) => {
      const before = await countContracts();
      await h
        .as(camila)
        .post('/contracts', {
          propertyId: camilaProperty,
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
          ...override,
        })
        .expect(400);
      expect(await countContracts()).toBe(before);
    });

    it('rejects foreign or nonexistent property, rental and document (404)', async () => {
      const before = await countContracts();
      const base = { startsOn: '2025-12-16', endsOn: '2026-12-15' };
      await h
        .as(andres)
        .post('/contracts', { ...base, propertyId: camilaProperty })
        .expect(404);
      await h
        .as(andres)
        .post('/contracts', { ...base, propertyId: randomUUID() })
        .expect(404);
      const rental = await h
        .as(andres)
        .post('/contracts', {
          ...base,
          propertyId: andresProperty,
          rentalId: camilaRental,
        })
        .expect(404);
      expect(rental.body.message).toBe('Arriendo no encontrado');
      await h
        .as(andres)
        .post('/contracts', {
          ...base,
          propertyId: andresProperty,
          documentId: await newDocument(camila),
        })
        .expect(404);
      expect(await countContracts()).toBe(before);
    });

    it('rejects a rental of another own property and a non-contract document (400)', async () => {
      const otherProperty = await newProperty(andres);
      const res = await h
        .as(andres)
        .post('/contracts', {
          propertyId: otherProperty,
          rentalId: andresRental,
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
        })
        .expect(400);
      expect(res.body.message).toBe(
        'El arriendo indicado no corresponde al inmueble del contrato',
      );
      await h
        .as(andres)
        .post('/contracts', {
          propertyId: andresProperty,
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
          documentId: await newDocument(andres, 'invoice'),
        })
        .expect(400);
    });

    it('rejects an inactive property (409)', async () => {
      const inactive = await newProperty(andres);
      await h
        .as(andres)
        .patch(`/properties/${inactive}`, { status: 'archived' })
        .expect(200);
      await h
        .as(andres)
        .post('/contracts', {
          propertyId: inactive,
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
        })
        .expect(409);
    });
  });

  describe('queries', () => {
    it('returns own contracts and hides foreign ones (404)', async () => {
      const own = await newContract(camila, { propertyId: camilaProperty });
      await h.as(camila).get(`/contracts/${own.id}`).expect(200);
      const foreign = await h
        .as(andres)
        .get(`/contracts/${own.id}`)
        .expect(404);
      expect(foreign.body.message).toBe('Contrato no encontrado');
      expect(JSON.stringify(foreign.body)).not.toContain(own.id);
      await h.as(camila).get(`/contracts/${randomUUID()}`).expect(404);
      await h.as(camila).get('/contracts/xyz').expect(400);
    });

    it('lists only own contracts ordered by end date, with filters', async () => {
      const user = await createTestUser(t.db, {
        email: `list-${uniq()}@notihouse.test`,
        password: pw(),
        displayName: 'Listados',
      });
      const p1 = await newProperty(user);
      const p2 = await newProperty(user);
      const r1 = await newRental(user, p1);
      const late = await newContract(user, {
        propertyId: p1,
        rentalId: r1,
        endsOn: '2027-06-30',
      });
      const soon = await newContract(user, {
        propertyId: p2,
        endsOn: '2026-11-30',
      });
      const mid = await newContract(user, {
        propertyId: p1,
        endsOn: '2026-12-31',
      });
      await h
        .as(user)
        .patch(`/contracts/${mid.id}`, { status: 'terminated' })
        .expect(200);

      const ids = (body: { items: { id: string }[] }) =>
        body.items.map((c) => c.id);
      const all = (await h.as(user).get('/contracts').expect(200)).body;
      expect(all.total).toBe(3);
      expect(ids(all)).toEqual([soon.id, mid.id, late.id]);

      expect(
        ids(
          (await h.as(user).get(`/contracts?propertyId=${p1}`).expect(200))
            .body,
        ),
      ).toEqual([mid.id, late.id]);
      expect(
        ids(
          (await h.as(user).get(`/contracts?rentalId=${r1}`).expect(200)).body,
        ),
      ).toEqual([late.id]);
      expect(
        ids(
          (await h.as(user).get('/contracts?status=active').expect(200)).body,
        ),
      ).toEqual([soon.id, late.id]);
      expect(
        ids(
          (
            await h
              .as(user)
              .get('/contracts?endsFrom=2026-12-01&endsTo=2027-01-31')
              .expect(200)
          ).body,
        ),
      ).toEqual([mid.id]);
      expect(
        ids(
          (await h.as(user).get('/contracts?page=2&pageSize=2').expect(200))
            .body,
        ),
      ).toEqual([late.id]);

      // Filtros con recursos ajenos no revelan nada.
      expect(
        (
          await h
            .as(user)
            .get(`/contracts?propertyId=${camilaProperty}`)
            .expect(200)
        ).body,
      ).toMatchObject({ items: [], total: 0 });
      expect(
        (
          await h
            .as(user)
            .get(`/contracts?rentalId=${camilaRental}`)
            .expect(200)
        ).body,
      ).toMatchObject({ items: [], total: 0 });

      await h.as(user).get('/contracts?status=renewed').expect(400);
      await h.as(user).get('/contracts?endsTo=2026-02-30').expect(400);
      await h.as(user).get('/contracts?pageSize=500').expect(400);
    });

    it('never expires a contract automatically when its end date has passed', async () => {
      const past = await newContract(camila, {
        propertyId: camilaProperty,
        startsOn: '2024-01-01',
        endsOn: '2024-12-31',
      });
      await h.as(camila).get('/contracts').expect(200);
      expect(
        (await h.as(camila).get(`/contracts/${past.id}`).expect(200)).body,
      ).toMatchObject({ status: 'active', endsOn: '2024-12-31' });
      expect(await countAudit('contract.update', past.id)).toBe(0);
    });
  });

  describe('updates', () => {
    it('corrects dates and audits the previous and new values', async () => {
      const own = await newContract(camila, { propertyId: camilaProperty });
      const res = await h
        .as(camila)
        .patch(`/contracts/${own.id}`, {
          endsOn: '2027-01-15',
          noticePeriodDays: 60,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        endsOn: '2027-01-15',
        noticePeriodDays: 60,
        status: 'active',
      });

      const audit = await t.client.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'contract.update' AND metadata->>'resourceId' = $1`,
        [own.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata).toMatchObject({
        changes: ['endsOn', 'noticePeriodDays'],
        dateChanges: { endsOn: { from: '2026-12-15', to: '2027-01-15' } },
      });
    });

    it('does not create a new contract when the end date is corrected', async () => {
      const own = await newContract(camila, { propertyId: camilaProperty });
      const before = await countContracts();
      await h
        .as(camila)
        .patch(`/contracts/${own.id}`, { endsOn: '2027-12-15' })
        .expect(200);
      expect(await countContracts()).toBe(before);
    });

    it.each([
      ['owner', { ownerId: randomUUID() }],
      ['property', { propertyId: randomUUID() }],
      ['rental', { rentalId: randomUUID() }],
      ['null end date', { endsOn: null }],
      ['end before start', { endsOn: '2025-01-01' }],
      ['unknown status', { status: 'renewed' }],
      ['empty patch', {}],
    ])('rejects a PATCH with %s (400)', async (_case, body) => {
      const own = await newContract(camila, {
        propertyId: camilaProperty,
        rentalId: camilaRental,
      });
      await h.as(camila).patch(`/contracts/${own.id}`, body).expect(400);
      expect(
        (await h.as(camila).get(`/contracts/${own.id}`).expect(200)).body,
      ).toMatchObject({
        propertyId: camilaProperty,
        rentalId: camilaRental,
        endsOn: '2026-12-15',
        status: 'active',
      });
    });

    it('does not let another user edit a contract (404, unchanged)', async () => {
      const own = await newContract(camila, { propertyId: camilaProperty });
      await h
        .as(andres)
        .patch(`/contracts/${own.id}`, { endsOn: '2030-01-01' })
        .expect(404);
      expect(
        (await h.as(camila).get(`/contracts/${own.id}`).expect(200)).body
          .endsOn,
      ).toBe('2026-12-15');
    });

    it('links only own contract documents and can unlink them', async () => {
      const own = await newContract(camila, { propertyId: camilaProperty });
      await h
        .as(camila)
        .patch(`/contracts/${own.id}`, {
          documentId: await newDocument(andres),
        })
        .expect(404);
      const doc = await newDocument(camila);
      await h
        .as(camila)
        .patch(`/contracts/${own.id}`, { documentId: doc })
        .expect(200);
      expect(
        (
          await h
            .as(camila)
            .patch(`/contracts/${own.id}`, { documentId: null })
            .expect(200)
        ).body.documentId,
      ).toBeNull();
    });

    it('treats expired and terminated contracts as final', async () => {
      for (const status of ['expired', 'terminated'] as const) {
        const own = await newContract(camila, { propertyId: camilaProperty });
        const path = `/contracts/${own.id}`;
        await h.as(camila).patch(path, { status }).expect(200);
        await h.as(camila).patch(path, { status: 'active' }).expect(409);
        await h.as(camila).patch(path, { endsOn: '2030-01-01' }).expect(409);
        expect((await h.as(camila).get(path).expect(200)).body).toMatchObject({
          status,
          endsOn: '2026-12-15',
        });
      }
    });

    it('keeps the contract untouched when its rental changes or ends', async () => {
      const property = await newProperty(camila);
      const rental = await newRental(camila, property);
      const own = await newContract(camila, {
        propertyId: property,
        rentalId: rental,
      });
      const before = (
        await h.as(camila).get(`/contracts/${own.id}`).expect(200)
      ).body;
      await h
        .as(camila)
        .patch(`/rentals/${rental}`, { endsOn: '2026-06-30', status: 'ended' })
        .expect(200);
      expect(
        (await h.as(camila).get(`/contracts/${own.id}`).expect(200)).body,
      ).toEqual(before);
    });
  });

  describe('transactional audit', () => {
    let failing: TestApp;

    beforeAll(async () => {
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

    it('rolls back contract creation and update when auditing fails', async () => {
      const before = await countContracts();
      await failing
        .as(camila)
        .post('/contracts', {
          propertyId: camilaProperty,
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
        })
        .expect(500);
      expect(await countContracts()).toBe(before);

      const own = await newContract(camila, { propertyId: camilaProperty });
      await failing
        .as(camila)
        .patch(`/contracts/${own.id}`, { status: 'terminated' })
        .expect(500);
      expect(
        (await h.as(camila).get(`/contracts/${own.id}`).expect(200)).body
          .status,
      ).toBe('active');
    });
  });
});
