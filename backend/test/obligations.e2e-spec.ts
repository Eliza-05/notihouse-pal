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
 * Obligaciones, períodos y confirmación manual sobre PostgreSQL en memoria
 * (PGlite con las migraciones versionadas): reglas de negocio, aislamiento por
 * propietario, idempotencia/concurrencia y auditoría transaccional.
 */
describe('Obligations and occurrences (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let laura: TestUser;
  let andres: TestUser;
  let lauraProperty: string;
  let andresProperty: string;

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

  const newObligation = async (user: TestUser, body: object = {}) =>
    (
      await h
        .as(user)
        .post('/obligations', {
          providerName: 'Empresa de energía',
          concept: `Energía ${uniq()}`,
          category: 'electricity',
          expectedAmount: '145000.00',
          dueDay: 18,
          ...body,
        })
        .expect(201)
    ).body as { id: string; expectedAmount: string | null };

  const newOccurrence = async (
    user: TestUser,
    obligationId: string,
    body: object = {},
  ) =>
    (
      await h
        .as(user)
        .post(`/obligations/${obligationId}/occurrences`, {
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          dueDate: '2026-11-18',
          ...body,
        })
        .expect(201)
    ).body as { id: string; status: string; amount: string | null };

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
    lauraProperty = (
      await h.as(laura).post('/properties', { name: 'Hogar Laura' }).expect(201)
    ).body.id;
    andresProperty = (
      await h
        .as(andres)
        .post('/properties', { name: 'Hogar Andrés' })
        .expect(201)
    ).body.id;
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
    await t.client.close();
  });

  describe('obligations', () => {
    it('requires a valid JWT', async () => {
      await request(h.app.getHttpServer())
        .get('/api/v1/obligations')
        .expect(401);
      await request(h.app.getHttpServer())
        .post(
          `/api/v1/obligations/${randomUUID()}/occurrences/${randomUUID()}/confirm`,
        )
        .send({ result: 'paid' })
        .expect(401);
    });

    it('creates an obligation without property, with defaults, and audits it', async () => {
      const res = await h
        .as(laura)
        .post('/obligations', {
          providerName: 'Proveedor de internet',
          concept: 'Internet',
          category: 'internet',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        propertyId: null,
        expectedAmount: null,
        currency: 'COP',
        frequency: 'monthly',
        reminderDaysBefore: 3,
        status: 'active',
      });
      expect(res.body).not.toHaveProperty('ownerId');
      expect(await countAudit('obligation.create', res.body.id)).toBe(1);
    });

    it('associates an obligation with an own active property only', async () => {
      const own = await newObligation(laura, { propertyId: lauraProperty });
      expect(
        (await h.as(laura).get(`/obligations/${own.id}`).expect(200)).body
          .propertyId,
      ).toBe(lauraProperty);

      const before = Number(
        (
          await t.client.query<{ n: string }>(
            'SELECT count(*) AS n FROM obligations',
          )
        ).rows[0]!.n,
      );
      const foreign = await h
        .as(laura)
        .post('/obligations', {
          providerName: 'X',
          concept: 'Y',
          category: 'gas',
          propertyId: andresProperty,
        })
        .expect(404);
      expect(JSON.stringify(foreign.body)).not.toContain('Hogar Andrés');
      const after = Number(
        (
          await t.client.query<{ n: string }>(
            'SELECT count(*) AS n FROM obligations',
          )
        ).rows[0]!.n,
      );
      expect(after).toBe(before);

      const inactive = (
        await h
          .as(laura)
          .post('/properties', { name: `Inactivo ${uniq()}` })
          .expect(201)
      ).body.id;
      await h
        .as(laura)
        .patch(`/properties/${inactive}`, { status: 'inactive' })
        .expect(200);
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'X',
          concept: 'Y',
          category: 'gas',
          propertyId: inactive,
        })
        .expect(409);
    });

    it.each([
      ['negative amount', { expectedAmount: '-1' }],
      ['three decimals', { expectedAmount: '1.234' }],
      ['numeric amount', { expectedAmount: 145000 }],
      ['non numeric amount', { expectedAmount: 'abc' }],
      ['amount too large', { expectedAmount: '1234567890123' }],
      ['impossible date', { startsOn: '2026-02-30' }],
      ['wrong date format', { startsOn: '2026/01/01' }],
      ['unknown category', { category: 'casino' }],
      ['due day out of range', { dueDay: 32 }],
      ['archived on creation', { status: 'archived' }],
      ['lowercase currency', { currency: 'cop' }],
      ['client-chosen owner', { ownerId: randomUUID() }],
    ])('rejects invalid input (%s) with 400', async (_case, override) => {
      await h
        .as(laura)
        .post('/obligations', {
          providerName: 'X',
          concept: 'Y',
          category: 'water',
          ...override,
        })
        .expect(400);
    });

    it('lists only own obligations, with property and status filters', async () => {
      const mine = await newObligation(andres, { propertyId: andresProperty });
      await newObligation(andres);
      const list = (
        await h.as(andres).get('/obligations?pageSize=100').expect(200)
      ).body;
      const lauraIds = (
        await h.as(laura).get('/obligations?pageSize=100').expect(200)
      ).body.items.map((o: { id: string }) => o.id);
      expect(
        list.items.some((o: { id: string }) => lauraIds.includes(o.id)),
      ).toBe(false);

      const byProperty = (
        await h
          .as(andres)
          .get(`/obligations?propertyId=${andresProperty}`)
          .expect(200)
      ).body;
      expect(byProperty.items.map((o: { id: string }) => o.id)).toEqual([
        mine.id,
      ]);
      // Filtrar por el inmueble de otro usuario no revela nada.
      expect(
        (
          await h
            .as(laura)
            .get(`/obligations?propertyId=${andresProperty}`)
            .expect(200)
        ).body,
      ).toMatchObject({ items: [], total: 0 });

      await h
        .as(andres)
        .patch(`/obligations/${mine.id}`, { status: 'paused' })
        .expect(200);
      const paused = (
        await h.as(andres).get('/obligations?status=paused').expect(200)
      ).body;
      expect(paused.items.map((o: { id: string }) => o.id)).toEqual([mine.id]);
    });

    it('hides foreign obligations (404) and blocks foreign updates', async () => {
      const own = await newObligation(laura);
      await h.as(andres).get(`/obligations/${own.id}`).expect(404);
      await h
        .as(andres)
        .patch(`/obligations/${own.id}`, { concept: 'Robado' })
        .expect(404);
      expect(await countAudit('obligation.update', own.id)).toBe(0);
    });

    it('updates the definition without touching existing occurrence values', async () => {
      const own = await newObligation(laura, { expectedAmount: '100000.00' });
      const occurrence = await newOccurrence(laura, own.id);
      expect(occurrence.amount).toBe('100000.00');

      const res = await h
        .as(laura)
        .patch(`/obligations/${own.id}`, {
          expectedAmount: '120000.50',
          dueDay: null,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        expectedAmount: '120000.50',
        dueDay: null,
      });
      const kept = (
        await h
          .as(laura)
          .get(`/obligations/${own.id}/occurrences/${occurrence.id}`)
          .expect(200)
      ).body;
      expect(kept.amount).toBe('100000.00');
    });

    it('rejects forbidden updates (owner, currency, foreign property) and freezes archived obligations', async () => {
      const own = await newObligation(laura, { propertyId: lauraProperty });
      await h
        .as(laura)
        .patch(`/obligations/${own.id}`, { ownerId: andres.profileId })
        .expect(400);
      await h
        .as(laura)
        .patch(`/obligations/${own.id}`, { currency: 'USD' })
        .expect(400);
      await h
        .as(laura)
        .patch(`/obligations/${own.id}`, { propertyId: andresProperty })
        .expect(404);
      expect(
        (
          await h
            .as(laura)
            .patch(`/obligations/${own.id}`, { propertyId: null })
            .expect(200)
        ).body.propertyId,
      ).toBeNull();

      await h
        .as(laura)
        .patch(`/obligations/${own.id}`, { status: 'archived' })
        .expect(200);
      await h
        .as(laura)
        .patch(`/obligations/${own.id}`, { concept: 'Otro' })
        .expect(409);
      await h
        .as(laura)
        .post(`/obligations/${own.id}/occurrences`, {
          periodStart: '2026-12-01',
          periodEnd: '2026-12-31',
          dueDate: '2026-12-18',
        })
        .expect(409);
    });
  });

  describe('occurrences', () => {
    it('creates a pending occurrence copying amount and currency, preserving exact amounts', async () => {
      const own = await newObligation(laura, {
        expectedAmount: '98000.00',
        currency: 'COP',
      });
      const copied = await newOccurrence(laura, own.id);
      expect(copied).toMatchObject({
        status: 'pending',
        amount: '98000.00',
        currency: 'COP',
        confirmedAt: null,
        confirmedBy: null,
      });

      const exact = await newOccurrence(laura, own.id, {
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-12-18',
        amount: '999999999999.99',
      });
      expect(exact.amount).toBe('999999999999.99');
      expect(await countAudit('obligation_occurrence.create', exact.id)).toBe(
        1,
      );
    });

    it('rejects duplicated periods (409) and invalid dates or amounts (400)', async () => {
      const own = await newObligation(laura);
      await newOccurrence(laura, own.id);
      const dup = await h
        .as(laura)
        .post(`/obligations/${own.id}/occurrences`, {
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          dueDate: '2026-11-20',
        })
        .expect(409);
      expect(dup.body.message).toBe(
        'Ya existe un período con esa fecha de inicio para esta obligación',
      );

      const base = {
        periodStart: '2027-01-01',
        periodEnd: '2027-01-31',
        dueDate: '2027-01-18',
      };
      for (const body of [
        { ...base, periodEnd: '2026-12-31' },
        { ...base, dueDate: '2027-02-29' },
        { ...base, amount: '-5.00' },
        { ...base, amount: '10.999' },
        { ...base, status: 'paid' },
      ]) {
        await h
          .as(laura)
          .post(`/obligations/${own.id}/occurrences`, body)
          .expect(400);
      }
    });

    it('lists occurrences ordered by due date with status filter and pagination', async () => {
      const own = await newObligation(laura);
      await newOccurrence(laura, own.id, {
        periodStart: '2027-03-01',
        periodEnd: '2027-03-31',
        dueDate: '2027-03-18',
      });
      await newOccurrence(laura, own.id, {
        periodStart: '2027-01-01',
        periodEnd: '2027-01-31',
        dueDate: '2027-01-18',
      });
      const feb = await newOccurrence(laura, own.id, {
        periodStart: '2027-02-01',
        periodEnd: '2027-02-28',
        dueDate: '2027-02-18',
      });

      const list = (
        await h.as(laura).get(`/obligations/${own.id}/occurrences`).expect(200)
      ).body;
      expect(list.items.map((o: { dueDate: string }) => o.dueDate)).toEqual([
        '2027-01-18',
        '2027-02-18',
        '2027-03-18',
      ]);
      expect(
        (
          await h
            .as(laura)
            .get(`/obligations/${own.id}/occurrences?page=2&pageSize=1`)
            .expect(200)
        ).body.items[0].id,
      ).toBe(feb.id);

      await h
        .as(laura)
        .patch(`/obligations/${own.id}/occurrences/${feb.id}`, {
          status: 'cancelled',
        })
        .expect(200);
      const cancelled = (
        await h
          .as(laura)
          .get(`/obligations/${own.id}/occurrences?status=cancelled`)
          .expect(200)
      ).body;
      expect(cancelled.items.map((o: { id: string }) => o.id)).toEqual([
        feb.id,
      ]);
    });

    it('hides foreign occurrences and rejects mismatched obligation/occurrence pairs', async () => {
      const own = await newObligation(laura);
      const other = await newObligation(laura);
      const occurrence = await newOccurrence(laura, own.id);

      await h.as(andres).get(`/obligations/${own.id}/occurrences`).expect(404);
      await h
        .as(andres)
        .get(`/obligations/${own.id}/occurrences/${occurrence.id}`)
        .expect(404);
      await h
        .as(andres)
        .post(`/obligations/${own.id}/occurrences`, {
          periodStart: '2027-05-01',
          periodEnd: '2027-05-31',
          dueDate: '2027-05-18',
        })
        .expect(404);
      await h
        .as(andres)
        .patch(`/obligations/${own.id}/occurrences/${occurrence.id}`, {
          amount: '1.00',
        })
        .expect(404);
      // Período real, pero de otra obligación del mismo usuario.
      await h
        .as(laura)
        .get(`/obligations/${other.id}/occurrences/${occurrence.id}`)
        .expect(404);
    });

    it('edits pending occurrences, audits it, and freezes confirmed or cancelled ones', async () => {
      const own = await newObligation(laura);
      const occurrence = await newOccurrence(laura, own.id);
      const edited = await h
        .as(laura)
        .patch(`/obligations/${own.id}/occurrences/${occurrence.id}`, {
          amount: '150000.25',
          dueDate: '2026-11-20',
        })
        .expect(200);
      expect(edited.body).toMatchObject({
        amount: '150000.25',
        dueDate: '2026-11-20',
        status: 'pending',
      });
      expect(
        await countAudit('obligation_occurrence.update', occurrence.id),
      ).toBe(1);

      // PATCH nunca marca pagos ni acepta campos de confirmación.
      await h
        .as(laura)
        .patch(`/obligations/${own.id}/occurrences/${occurrence.id}`, {
          status: 'paid',
        })
        .expect(400);
      await h
        .as(laura)
        .patch(`/obligations/${own.id}/occurrences/${occurrence.id}`, {
          confirmedBy: laura.profileId,
        })
        .expect(400);

      await h
        .as(laura)
        .post(`/obligations/${own.id}/occurrences/${occurrence.id}/confirm`, {
          result: 'paid',
        })
        .expect(200);
      await h
        .as(laura)
        .patch(`/obligations/${own.id}/occurrences/${occurrence.id}`, {
          amount: '1.00',
        })
        .expect(409);

      const cancelled = await newOccurrence(laura, own.id, {
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-12-18',
      });
      await h
        .as(laura)
        .patch(`/obligations/${own.id}/occurrences/${cancelled.id}`, {
          status: 'cancelled',
        })
        .expect(200);
      await h
        .as(laura)
        .patch(`/obligations/${own.id}/occurrences/${cancelled.id}`, {
          amount: '1.00',
        })
        .expect(409);
    });

    it('never confirms automatically, even after the due date', async () => {
      const own = await newObligation(laura);
      const past = await newOccurrence(laura, own.id, {
        periodStart: '2025-01-01',
        periodEnd: '2025-01-31',
        dueDate: '2025-01-18',
      });
      const read = (
        await h
          .as(laura)
          .get(`/obligations/${own.id}/occurrences/${past.id}`)
          .expect(200)
      ).body;
      expect(read).toMatchObject({
        status: 'pending',
        confirmedAt: null,
        confirmedBy: null,
      });
    });
  });

  describe('manual confirmation', () => {
    it('records the human confirmation with server time and the authenticated user', async () => {
      const own = await newObligation(laura);
      const occurrence = await newOccurrence(laura, own.id);
      const correlationId = randomUUID();
      const before = Date.now();

      const res = await h
        .as(laura)
        .post(`/obligations/${own.id}/occurrences/${occurrence.id}/confirm`, {
          result: 'paid',
          reference: 'Comprobante 123',
        })
        .set('X-Correlation-Id', correlationId)
        .expect(200);

      expect(res.body).toMatchObject({
        status: 'paid',
        confirmedBy: laura.profileId,
        confirmationReference: 'Comprobante 123',
      });
      const confirmedAt = new Date(res.body.confirmedAt).getTime();
      expect(confirmedAt).toBeGreaterThanOrEqual(before - 5_000);
      expect(confirmedAt).toBeLessThanOrEqual(Date.now() + 5_000);

      const events = await t.client.query<{
        actor_id: string;
        correlation_id: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT actor_id, correlation_id, metadata FROM audit_events WHERE action = 'obligation_occurrence.confirm' AND metadata->>'resourceId' = $1`,
        [occurrence.id],
      );
      expect(events.rows).toEqual([
        expect.objectContaining({
          actor_id: laura.profileId,
          correlation_id: correlationId,
          metadata: expect.objectContaining({
            humanConfirmation: true,
            statusFrom: 'pending',
            statusTo: 'paid',
          }),
        }),
      ]);
    });

    it('rejects client-supplied confirmation fields and invalid results', async () => {
      const own = await newObligation(laura);
      const occurrence = await newOccurrence(laura, own.id);
      const path = `/obligations/${own.id}/occurrences/${occurrence.id}/confirm`;
      await h
        .as(laura)
        .post(path, { result: 'paid', confirmedBy: andres.profileId })
        .expect(400);
      await h
        .as(laura)
        .post(path, { result: 'paid', confirmedAt: '2020-01-01T00:00:00Z' })
        .expect(400);
      await h.as(laura).post(path, { result: 'cancelled' }).expect(400);
      await h.as(laura).post(path, {}).expect(400);
      expect(
        (
          await h
            .as(laura)
            .get(`/obligations/${own.id}/occurrences/${occurrence.id}`)
            .expect(200)
        ).body.status,
      ).toBe('pending');
    });

    it('does not let another user confirm', async () => {
      const own = await newObligation(laura);
      const occurrence = await newOccurrence(laura, own.id);
      await h
        .as(andres)
        .post(`/obligations/${own.id}/occurrences/${occurrence.id}/confirm`, {
          result: 'paid',
        })
        .expect(404);
      expect(
        (
          await h
            .as(laura)
            .get(`/obligations/${own.id}/occurrences/${occurrence.id}`)
            .expect(200)
        ).body.status,
      ).toBe('pending');
    });

    it('is idempotent for the same result and rejects contradictory or cancelled confirmations (409)', async () => {
      const own = await newObligation(laura);
      const occurrence = await newOccurrence(laura, own.id);
      const path = `/obligations/${own.id}/occurrences/${occurrence.id}/confirm`;

      const first = (
        await h.as(laura).post(path, { result: 'attended' }).expect(200)
      ).body;
      const second = (
        await h.as(laura).post(path, { result: 'attended' }).expect(200)
      ).body;
      expect(second.confirmedAt).toBe(first.confirmedAt);
      await h.as(laura).post(path, { result: 'paid' }).expect(409);
      expect(
        await countAudit('obligation_occurrence.confirm', occurrence.id),
      ).toBe(1);

      const cancelled = await newOccurrence(laura, own.id, {
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-12-18',
      });
      await h
        .as(laura)
        .patch(`/obligations/${own.id}/occurrences/${cancelled.id}`, {
          status: 'cancelled',
        })
        .expect(200);
      await h
        .as(laura)
        .post(`/obligations/${own.id}/occurrences/${cancelled.id}/confirm`, {
          result: 'paid',
        })
        .expect(409);
    });

    it('lets only one of two concurrent contradictory confirmations win', async () => {
      const own = await newObligation(laura);
      const occurrence = await newOccurrence(laura, own.id);
      const path = `/obligations/${own.id}/occurrences/${occurrence.id}/confirm`;

      const responses = await Promise.all([
        h.as(laura).post(path, { result: 'paid' }),
        h.as(laura).post(path, { result: 'attended' }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = responses.find((r) => r.status === 200)!.body.status;
      expect(
        (
          await h
            .as(laura)
            .get(`/obligations/${own.id}/occurrences/${occurrence.id}`)
            .expect(200)
        ).body.status,
      ).toBe(winner);
      expect(
        await countAudit('obligation_occurrence.confirm', occurrence.id),
      ).toBe(1);
    });

    it('records a single transition for concurrent identical confirmations (double click)', async () => {
      const own = await newObligation(laura);
      const occurrence = await newOccurrence(laura, own.id);
      const path = `/obligations/${own.id}/occurrences/${occurrence.id}/confirm`;

      const responses = await Promise.all([
        h.as(laura).post(path, { result: 'paid' }),
        h.as(laura).post(path, { result: 'paid' }),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      expect(responses[0]!.body.confirmedAt).toBe(
        responses[1]!.body.confirmedAt,
      );
      expect(
        await countAudit('obligation_occurrence.confirm', occurrence.id),
      ).toBe(1);
    });
  });

  describe('transactional audit', () => {
    let failing: TestApp;

    beforeAll(async () => {
      // Misma aplicación, pero la auditoría falla: ninguna escritura debe quedar aplicada.
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

    it('rolls back a property creation when its audit event fails', async () => {
      const name = `Rollback ${uniq()}`;
      await failing.as(laura).post('/properties', { name }).expect(500);
      const rows = await t.client.query(
        'SELECT 1 FROM properties WHERE name = $1',
        [name],
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('rolls back an obligation update and a confirmation when auditing fails', async () => {
      const own = await newObligation(laura, { concept: 'Original' });
      const occurrence = await newOccurrence(laura, own.id);

      await failing
        .as(laura)
        .patch(`/obligations/${own.id}`, { concept: 'Modificado' })
        .expect(500);
      expect(
        (await h.as(laura).get(`/obligations/${own.id}`).expect(200)).body
          .concept,
      ).toBe('Original');

      await failing
        .as(laura)
        .post(`/obligations/${own.id}/occurrences/${occurrence.id}/confirm`, {
          result: 'paid',
        })
        .expect(500);
      const after = (
        await h
          .as(laura)
          .get(`/obligations/${own.id}/occurrences/${occurrence.id}`)
          .expect(200)
      ).body;
      expect(after).toMatchObject({
        status: 'pending',
        confirmedAt: null,
        confirmedBy: null,
      });
    });

    it('keeps existing audit events immutable', async () => {
      for (const statement of [
        'UPDATE audit_events SET action = $1',
        'DELETE FROM audit_events WHERE action <> $1',
      ]) {
        await expect(t.client.query(statement, ['x'])).rejects.toThrow(
          /append-only/,
        );
      }
    });
  });
});
