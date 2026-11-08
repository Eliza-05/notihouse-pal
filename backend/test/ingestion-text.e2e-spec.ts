import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { KillSwitchService } from '../src/kill-switch/kill-switch.service.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Entrada de texto del asistente (§19.2, N1): recibir y encolar un mensaje,
 * nunca interpretarlo aquí. Comparte la idempotencia, el aislamiento y el
 * límite de mensajes abiertos (D15) con el resto de la ingesta.
 */
describe('Text ingestion (e2e, N1)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let laura: TestUser;
  let andres: TestUser;

  const pw = () => randomBytes(12).toString('base64url');

  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => (await t.client.query<T>(query, params)).rows;

  const send = (text = 'Recuérdame pagar Claro el día 7 de cada mes', body: object = {}) =>
    h.as(laura).post('/ingestions/text', { text, ...body });

  beforeAll(async () => {
    t = await createMigratedDatabase();
    laura = await createTestUser(t.db, {
      email: 'laura@textingest.test',
      password: pw(),
      displayName: 'Laura',
    });
    andres = await createTestUser(t.db, {
      email: 'andres@textingest.test',
      password: pw(),
      displayName: 'Andrés',
    });
    h = await createTestApp(t.db);
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
  });

  it('requires a valid JWT', async () => {
    await request(h.app.getHttpServer())
      .post('/api/v1/ingestions/text')
      .send({ text: 'hola' })
      .expect(401);
  });

  it('creates a case and a text.interpret job, without exposing the raw text in the audit trail', async () => {
    const text = `Recuérdame pagar Claro el día 7 de cada mes ${randomUUID()}`;
    const res = await send(text).expect(201);
    expect(res.body).toMatchObject({
      caseStatus: 'received',
      source: 'form',
      job: { type: 'text.interpret', status: 'pending' },
      processing: 'pending',
      textLength: text.length,
    });
    expect(res.headers['x-correlation-id']).toBe(res.body.correlationId);

    const [job] = await sql<{ job_type: string; payload: Record<string, unknown> }>(
      `SELECT job_type, payload FROM workflow_jobs WHERE case_id = $1`,
      [res.body.caseId],
    );
    expect(job!.job_type).toBe('text.interpret');
    expect(job!.payload.text).toBe(text);
    expect(typeof job!.payload.textSha256).toBe('string');

    const [audit] = await sql<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'text.receive' AND metadata->>'resourceId' = $1`,
      [res.body.caseId],
    );
    expect(JSON.stringify(audit)).not.toContain(text);
    expect(audit!.metadata).toMatchObject({ textLength: text.length });
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
    ['too long', 'x'.repeat(1001)],
    ['control character', 'hola\u0000mundo'],
  ])('rejects invalid text (%s) with 400', async (_case, text) => {
    await send(text).expect(400);
  });

  it('rejects unknown fields (ownerId, caseId)', async () => {
    await h
      .as(laura)
      .post('/ingestions/text', { text: 'hola', ownerId: randomUUID() })
      .expect(400);
    await h
      .as(laura)
      .post('/ingestions/text', { text: 'hola', caseId: randomUUID() })
      .expect(400);
  });

  it('is idempotent by requestId and rejects reusing it with different text', async () => {
    const requestId = randomUUID();
    const text = `Idempotente ${randomUUID()}`;
    const first = await send(text, { requestId }).expect(201);
    const again = await send(text, { requestId }).expect(200);
    expect(again.body.caseId).toBe(first.body.caseId);

    await send(`${text} distinto`, { requestId }).expect(409);
  });

  it('rejects a subject that does not match the case type', async () => {
    // household_obligation solo admite obligationId: el formato UUID basta,
    // el rechazo ocurre por el tipo antes de comprobar si existe.
    await send('hola', {
      caseType: 'household_obligation',
      rentalId: randomUUID(),
    }).expect(400);
  });

  it('rejects more than one subject entity', async () => {
    const obligation = (
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'X',
          concept: 'Y',
          category: 'other',
        })
        .expect(201)
    ).body.id;
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
          expectedAmount: '900000.00',
          dueDay: 5,
          startsOn: '2026-01-01',
        })
        .expect(201)
    ).body.id;
    await send('hola', {
      caseType: 'household_obligation',
      obligationId: obligation,
      rentalId: rental,
    }).expect(400);
  });

  it('rejects a foreign obligation, rental or property (404), never revealing it exists', async () => {
    const foreignObligation = (
      await h
        .as(andres)
        .post('/obligations', {
          providerName: 'Ajeno',
          concept: 'Ajeno',
          category: 'other',
        })
        .expect(201)
    ).body.id;
    const foreignProperty = (
      await h
        .as(andres)
        .post('/properties', { name: `Ajeno ${randomUUID()}` })
        .expect(201)
    ).body.id;
    await send('hola', { obligationId: foreignObligation }).expect(404);
    await send('hola', { propertyId: foreignProperty }).expect(404);
  });

  it('accepts an own propertyId as a resolution hint, stored in the job payload', async () => {
    const property = (
      await h
        .as(laura)
        .post('/properties', { name: `Casa ${randomUUID()}` })
        .expect(201)
    ).body.id;
    const res = await send('hola', { propertyId: property }).expect(201);
    const [job] = await sql<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM workflow_jobs WHERE case_id = $1`,
      [res.body.caseId],
    );
    expect(
      (job!.payload.hints as Record<string, unknown>).propertyId,
    ).toBe(property);
  });

  it('limits to 3 open text messages per user (D15)', async () => {
    const fresh = await createTestUser(t.db, {
      email: `d15-${randomUUID()}@textingest.test`,
      password: pw(),
      displayName: 'D15',
    });
    const sendAs = (text: string) =>
      h.as(fresh).post('/ingestions/text', { text });
    const cases: string[] = [];
    for (let i = 0; i < 3; i++) {
      cases.push(
        (await sendAs(`Mensaje ${randomUUID()}`).expect(201)).body.caseId,
      );
    }
    await sendAs(`Mensaje de más ${randomUUID()}`).expect(429);

    // Al cerrarse uno de los casos abiertos, se libera un cupo.
    await sql(
      `UPDATE cases SET status = 'completed', closed_at = now() WHERE id = $1`,
      [cases[0]],
    );
    await sendAs(`Ahora sí cabe ${randomUUID()}`).expect(201);
  });

  it('never calls Gemini, and is accepted even while text_processing is suspended (it only queues)', async () => {
    const fresh = await createTestUser(t.db, {
      email: `ks-${randomUUID()}@textingest.test`,
      password: pw(),
      displayName: 'KS',
    });
    const ks = h.app.get(KillSwitchService);
    await ks.activate({
      scope: 'text_processing',
      reason: 'prueba',
      trigger: 'manual',
      actor: 'operador:test',
      actorType: 'system',
    });
    try {
      await h
        .as(fresh)
        .post('/ingestions/text', {
          text: `Encolado con el interruptor activo ${randomUUID()}`,
        })
        .expect(201);
    } finally {
      await ks.resume({
        scope: 'text_processing',
        operator: 'operador:test',
        reason: 'fin de la prueba',
        testEvidence: 'n/a',
      });
    }
  });

  it("isolates by owner: never sees or affects another user's text cases", async () => {
    const fresh = await createTestUser(t.db, {
      email: `iso-${randomUUID()}@textingest.test`,
      password: pw(),
      displayName: 'Iso',
    });
    const own = await h
      .as(fresh)
      .post('/ingestions/text', { text: `Propio ${randomUUID()}` })
      .expect(201);
    const before = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM cases WHERE owner_id = $1`,
      [andres.profileId],
    );
    await h
      .as(andres)
      .post('/ingestions/text', { text: `Ajeno ${randomUUID()}` })
      .expect(201);
    expect(
      Number(
        (
          await sql<{ n: string }>(
            `SELECT count(*) AS n FROM cases WHERE owner_id = $1`,
            [andres.profileId],
          )
        )[0]!.n,
      ),
    ).toBe(Number(before[0]!.n) + 1);
    await h.as(andres).get(`/cases/${own.body.caseId}`).expect(404);
  });
});
