import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/** Inmuebles: CRUD sin borrado, aislamiento por propietario y auditoría (PGlite). */
describe('Properties (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let laura: TestUser;
  let andres: TestUser;

  const pw = () => randomBytes(12).toString('base64url');
  const audits = async (action: string, resourceId: string) =>
    (
      await t.client.query<{
        actor_id: string;
        owner_id: string;
        actor_type: string;
        correlation_id: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT actor_id, owner_id, actor_type, correlation_id, metadata FROM audit_events
          WHERE action = $1 AND metadata->>'resourceId' = $2`,
        [action, resourceId],
      )
    ).rows;

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
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
    await t.client.close();
  });

  it('requires a valid JWT on every route', async () => {
    const server = h.app.getHttpServer();
    await request(server).get('/api/v1/properties').expect(401);
    await request(server)
      .post('/api/v1/properties')
      .send({ name: 'X' })
      .expect(401);
    await request(server)
      .get('/api/v1/properties')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('creates a property owned by the authenticated user and audits it', async () => {
    const correlationId = randomUUID();
    const res = await h
      .as(laura)
      .post('/properties', {
        name: '  Apartamento Centro ',
        address: 'Calle ficticia 1',
      })
      .set('X-Correlation-Id', correlationId)
      .expect(201);

    expect(res.body).toMatchObject({
      name: 'Apartamento Centro',
      address: 'Calle ficticia 1',
      description: null,
      status: 'active',
    });
    expect(res.body).not.toHaveProperty('ownerId');
    expect(res.headers['x-correlation-id']).toBe(correlationId);

    const owner = await t.client.query<{ owner_id: string }>(
      'SELECT owner_id FROM properties WHERE id = $1',
      [res.body.id],
    );
    expect(owner.rows[0]!.owner_id).toBe(laura.profileId);
    expect(await audits('property.create', res.body.id)).toEqual([
      expect.objectContaining({
        actor_id: laura.profileId,
        owner_id: laura.profileId,
        actor_type: 'user',
        correlation_id: correlationId,
      }),
    ]);
  });

  it.each([
    ['missing name', {}],
    ['blank name', { name: '   ' }],
    ['name too long', { name: 'x'.repeat(121) }],
    ['numeric address', { name: 'Casa', address: 123 }],
    ['client-chosen owner', { name: 'Casa', ownerId: randomUUID() }],
    ['status on create', { name: 'Casa', status: 'archived' }],
  ])('rejects invalid input (%s) with 400', async (_case, body) => {
    await h.as(laura).post('/properties', body).expect(400);
  });

  it('rejects a duplicated name for the same owner (409) but not across owners', async () => {
    await h
      .as(laura)
      .post('/properties', { name: 'Casa campestre' })
      .expect(201);
    const dup = await h
      .as(laura)
      .post('/properties', { name: 'Casa campestre' })
      .expect(409);
    expect(dup.body.message).toBe('Ya existe un inmueble con ese nombre');
    await h
      .as(andres)
      .post('/properties', { name: 'Casa campestre' })
      .expect(201);
  });

  it('lists only own properties with stable pagination and status filter', async () => {
    for (const name of ['P-1', 'P-2', 'P-3']) {
      await h.as(andres).post('/properties', { name }).expect(201);
    }
    const all = await h.as(andres).get('/properties?pageSize=100').expect(200);
    const lauraIds = (
      await h.as(laura).get('/properties?pageSize=100').expect(200)
    ).body.items.map((p: { id: string }) => p.id);
    expect(
      all.body.items.some((p: { id: string }) => lauraIds.includes(p.id)),
    ).toBe(false);
    expect(all.body.total).toBe(all.body.items.length);

    const page1 = await h
      .as(andres)
      .get('/properties?page=1&pageSize=2')
      .expect(200);
    const page2 = await h
      .as(andres)
      .get('/properties?page=2&pageSize=2')
      .expect(200);
    expect(page1.body).toMatchObject({
      page: 1,
      pageSize: 2,
      total: all.body.total,
    });
    expect(
      [...page1.body.items, ...page2.body.items].map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual(all.body.items.slice(0, 4).map((p: { id: string }) => p.id));

    const [first] = all.body.items;
    await h
      .as(andres)
      .patch(`/properties/${first.id}`, { status: 'inactive' })
      .expect(200);
    const inactive = await h
      .as(andres)
      .get('/properties?status=inactive')
      .expect(200);
    expect(inactive.body.items.map((p: { id: string }) => p.id)).toEqual([
      first.id,
    ]);
  });

  it.each([
    'pageSize=101',
    'pageSize=0',
    'page=0',
    'page=abc',
    'status=deleted',
  ])('rejects invalid list parameters (%s)', async (qs) => {
    await h.as(laura).get(`/properties?${qs}`).expect(400);
  });

  it('returns own property and 404 for unknown or foreign ones', async () => {
    const own = (
      await h
        .as(laura)
        .post('/properties', { name: 'Detalle propio' })
        .expect(201)
    ).body;
    await h.as(laura).get(`/properties/${own.id}`).expect(200);

    const foreign = await h.as(andres).get(`/properties/${own.id}`).expect(404);
    expect(JSON.stringify(foreign.body)).not.toContain('Detalle propio');
    await h.as(laura).get(`/properties/${randomUUID()}`).expect(404);
    await h.as(laura).get('/properties/not-a-uuid').expect(400);
  });

  it('updates allowed fields, audits the change and can deactivate by status', async () => {
    const own = (
      await h.as(laura).post('/properties', { name: 'Para editar' }).expect(201)
    ).body;
    const res = await h
      .as(laura)
      .patch(`/properties/${own.id}`, {
        address: 'Nueva dirección',
        description: null,
        status: 'archived',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      address: 'Nueva dirección',
      status: 'archived',
    });

    const [event] = await audits('property.update', own.id);
    expect(event!.metadata).toMatchObject({
      changes: ['address', 'status'],
      statusFrom: 'active',
      statusTo: 'archived',
    });
  });

  it('cannot update a foreign property, change the owner or send empty patches', async () => {
    const own = (
      await h.as(laura).post('/properties', { name: 'Protegido' }).expect(201)
    ).body;
    await h
      .as(andres)
      .patch(`/properties/${own.id}`, { name: 'Robado' })
      .expect(404);
    await h
      .as(laura)
      .patch(`/properties/${own.id}`, { ownerId: andres.profileId })
      .expect(400);
    await h.as(laura).patch(`/properties/${own.id}`, {}).expect(400);
    await h
      .as(laura)
      .patch(`/properties/${own.id}`, { name: null })
      .expect(400);

    const row = await t.client.query<{ name: string; owner_id: string }>(
      'SELECT name, owner_id FROM properties WHERE id = $1',
      [own.id],
    );
    expect(row.rows[0]).toEqual({
      name: 'Protegido',
      owner_id: laura.profileId,
    });
    expect(await audits('property.update', own.id)).toEqual([]);
  });

  it('exposes no DELETE route', async () => {
    const own = (
      await h.as(laura).post('/properties', { name: 'Sin borrado' }).expect(201)
    ).body;
    await request(h.app.getHttpServer())
      .delete(`/api/v1/properties/${own.id}`)
      .set('Authorization', `Bearer ${h.tokenFor(laura)}`)
      .expect(404);
    await h.as(laura).get(`/properties/${own.id}`).expect(200);
  });
});
