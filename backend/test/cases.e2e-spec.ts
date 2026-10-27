import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuditService } from '../src/audit/audit.service.js';
import { ServiceTokenVerifier } from '../src/auth/service-token.verifier.js';
import {
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Autenticación de servicio (n8n) separada de los usuarios, y API de casos:
 * creación atómica con su trabajo inicial, idempotencia y aislamiento.
 */
describe('Service authentication and cases (e2e)', () => {
  let w: ProcessWorld;
  const { sql, countAudit, drainQueue, newCase } = processHelpers(() => w);

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);

  afterAll(async () => {
    await w.h.app.close();
    await w.t.client.close();
  });

  describe('service authentication', () => {
    const INTERNAL = [
      ['post', '/api/v1/internal/workflow-jobs/claim'],
      ['get', `/api/v1/internal/workflow-jobs/${randomUUID()}`],
      ['post', `/api/v1/internal/workflow-jobs/${randomUUID()}/heartbeat`],
      ['post', `/api/v1/internal/workflow-jobs/${randomUUID()}/complete`],
      ['post', `/api/v1/internal/workflow-jobs/${randomUUID()}/fail`],
      ['post', `/api/v1/internal/cases/${randomUUID()}/proposals`],
      ['post', `/api/v1/internal/cases/${randomUUID()}/hitl-requests`],
      ['post', `/api/v1/internal/cases/${randomUUID()}/complete`],
      ['post', `/api/v1/internal/cases/${randomUUID()}/fail`],
      ['post', '/api/v1/internal/hitl-requests/expire'],
    ] as const;

    it.each(INTERNAL)(
      '%s %s rejects missing, wrong and user tokens (401)',
      async (method, path) => {
        const server = w.h.app.getHttpServer();
        await request(server)[method](path).send({}).expect(401);
        await request(server)
          [method](path)
          .set('Authorization', `Bearer ${process.env.N8N_SERVICE_TOKEN}x`)
          .send({})
          .expect(401);
        await request(server)
          [method](path)
          .set('Authorization', `Basic ${process.env.N8N_SERVICE_TOKEN}`)
          .send({})
          .expect(401);
        // Un JWT válido de usuario no abre rutas internas.
        const res = await request(server)
          [method](path)
          .set('Authorization', `Bearer ${w.h.tokenFor(w.laura)}`)
          .send({})
          .expect(401);
        expect(JSON.stringify(res.body)).not.toContain(
          process.env.N8N_SERVICE_TOKEN!,
        );
      },
    );

    it.each([
      ['get', '/api/v1/auth/me'],
      ['get', '/api/v1/cases'],
      ['post', '/api/v1/cases'],
      ['get', '/api/v1/hitl-requests'],
      ['get', '/api/v1/properties'],
      ['get', '/api/v1/rentals'],
      [
        'post',
        `/api/v1/rentals/${randomUUID()}/charges/${randomUUID()}/confirm`,
      ],
    ] as const)(
      'the service token cannot act as a user on %s %s (401)',
      async (method, path) => {
        await request(w.h.app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${process.env.N8N_SERVICE_TOKEN}`)
          .send({})
          .expect(401);
      },
    );

    it('accepts the service token on internal routes', async () => {
      await drainQueue();
      const res = await w.h
        .asService()
        .post('/internal/workflow-jobs/claim', { workerId: 'worker-1' })
        .expect(200);
      expect(res.body).toEqual({ jobs: [] });
    });

    it('rejects every internal request when no service token is configured', async () => {
      // La configuración se lee al importar AppModule; se sustituye el verificador.
      const unconfigured = await createTestApp(w.t.db, (b) =>
        b.overrideProvider(ServiceTokenVerifier).useValue(
          new ServiceTokenVerifier({
            get: () => undefined,
          } as unknown as ConstructorParameters<
            typeof ServiceTokenVerifier
          >[0]),
        ),
      );
      try {
        for (const token of ['', 'undefined', process.env.N8N_SERVICE_TOKEN!]) {
          await request(unconfigured.app.getHttpServer())
            .post('/api/v1/internal/workflow-jobs/claim')
            .set('Authorization', `Bearer ${token}`)
            .send({ workerId: 'worker-1' })
            .expect(401);
        }
      } finally {
        await unconfigured.app.close();
      }
    });
  });

  describe('case creation', () => {
    it('creates a received form case with its intake job, atomically audited', async () => {
      await drainQueue();
      const res = await w.h
        .as(w.laura)
        .post('/cases', {
          type: 'household_obligation',
          obligationId: w.lauraObligation,
        })
        .expect(201);
      expect(res.body).toMatchObject({
        type: 'household_obligation',
        source: 'form',
        status: 'received',
        obligationId: w.lauraObligation,
        rentalId: null,
        contractId: null,
        closedAt: null,
      });
      expect(res.body).not.toHaveProperty('ownerId');
      expect(res.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers['x-correlation-id']).toBe(res.body.correlationId);

      const [job] = await sql<Record<string, unknown>>(
        'SELECT job_type, status, payload, attempts FROM workflow_jobs WHERE case_id = $1',
        [res.body.id],
      );
      expect(job).toMatchObject({
        job_type: 'case.household_obligation',
        status: 'pending',
        attempts: 0,
        payload: {
          caseType: 'household_obligation',
          source: 'form',
          obligationId: w.lauraObligation,
        },
      });

      const events = await sql<Record<string, unknown>>(
        `SELECT action, actor_type, actor_id, owner_id FROM audit_events WHERE correlation_id = $1 ORDER BY occurred_at, action`,
        [res.body.correlationId],
      );
      expect(events.map((e) => e.action).sort()).toEqual([
        'case.create',
        'workflow_job.create',
      ]);
      for (const event of events) {
        expect(event).toMatchObject({
          actor_type: 'user',
          actor_id: w.laura.profileId,
          owner_id: w.laura.profileId,
        });
      }
    });

    it('creates cases without subject and for each matching type', async () => {
      await newCase(w.laura);
      await newCase(w.andres, {
        type: 'rent_collection',
        rentalId: w.andresRental,
      });
      await newCase(w.camila, {
        type: 'contract_review',
        contractId: w.camilaContract,
      });
    });

    it.each([
      ['unknown type', { type: 'payment' }],
      ['missing type', { type: undefined }],
      ['subject of another type', { rentalId: randomUUID() }],
      ['two subjects', { obligationId: randomUUID(), rentalId: randomUUID() }],
      ['client status', { status: 'completed' }],
      ['client source', { source: 'gmail' }],
      ['client owner', { ownerId: randomUUID() }],
      ['client correlation id', { correlationId: randomUUID() }],
      ['malformed request id', { requestId: 'abc' }],
    ])(
      'rejects invalid input (%s) with 400 and writes nothing',
      async (_c, body) => {
        const [{ n: before }] = await sql<{ n: string }>(
          'SELECT count(*) AS n FROM cases',
        );
        await w.h
          .as(w.laura)
          .post('/cases', { type: 'household_obligation', ...body })
          .expect(400);
        const [{ n: after }] = await sql<{ n: string }>(
          'SELECT count(*) AS n FROM cases',
        );
        expect(after).toBe(before);
      },
    );

    it('rejects references to other owners’ resources (404)', async () => {
      const [{ n: before }] = await sql<{ n: string }>(
        'SELECT count(*) AS n FROM cases',
      );
      await w.h
        .as(w.laura)
        .post('/cases', { type: 'rent_collection', rentalId: w.andresRental })
        .expect(404);
      await w.h
        .as(w.andres)
        .post('/cases', {
          type: 'contract_review',
          contractId: w.camilaContract,
        })
        .expect(404);
      await w.h
        .as(w.camila)
        .post('/cases', {
          type: 'household_obligation',
          obligationId: w.lauraObligation,
        })
        .expect(404);
      const [{ n: after }] = await sql<{ n: string }>(
        'SELECT count(*) AS n FROM cases',
      );
      expect(after).toBe(before);
    });

    it('is idempotent by requestId (sequential and concurrent)', async () => {
      const requestId = randomUUID();
      const body = { type: 'household_obligation', requestId };
      const first = await w.h.as(w.laura).post('/cases', body).expect(201);
      const again = await w.h.as(w.laura).post('/cases', body).expect(200);
      expect(again.body.id).toBe(first.body.id);
      await w.h
        .as(w.laura)
        .post('/cases', { ...body, obligationId: w.lauraObligation })
        .expect(409);

      const concurrentId = randomUUID();
      const responses = await Promise.all(
        [1, 2, 3].map(() =>
          w.h.as(w.laura).post('/cases', {
            type: 'household_obligation',
            requestId: concurrentId,
          }),
        ),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 201]);
      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      const jobs = await sql(
        `SELECT 1 FROM workflow_jobs WHERE idempotency_key = $1`,
        [`case-request:${w.laura.profileId}:${concurrentId}`],
      );
      expect(jobs).toHaveLength(1);

      // La misma clave en otro usuario es independiente.
      await w.h.as(w.andres).post('/cases', body).expect(201);
    });
  });

  describe('case queries and isolation', () => {
    it('lists only own cases, newest first, with filters and pagination', async () => {
      const own = await newCase(w.camila, { type: 'contract_review' });
      const all = (await w.h.as(w.camila).get('/cases').expect(200)).body;
      expect(all.items[0].id).toBe(own.id);
      expect(
        all.items.every((c: { type: string }) => c.type === 'contract_review'),
      ).toBe(true);

      const filtered = (
        await w.h
          .as(w.laura)
          .get('/cases?type=rent_collection&status=received')
          .expect(200)
      ).body;
      expect(filtered).toMatchObject({ items: [], total: 0 });
      const page = (
        await w.h.as(w.laura).get('/cases?page=1&pageSize=1').expect(200)
      ).body;
      expect(page.items).toHaveLength(1);
      expect(page.total).toBeGreaterThan(1);

      await w.h.as(w.laura).get('/cases?status=open').expect(400);
      await w.h.as(w.laura).get('/cases?pageSize=101').expect(400);
    });

    it('hides foreign and nonexistent cases (404)', async () => {
      const andresCase = await newCase(w.andres, { type: 'rent_collection' });
      await w.h.as(w.andres).get(`/cases/${andresCase.id}`).expect(200);
      const foreign = await w.h
        .as(w.laura)
        .get(`/cases/${andresCase.id}`)
        .expect(404);
      expect(foreign.body.message).toBe('Caso no encontrado');
      await w.h
        .as(w.laura)
        .get(`/cases/${andresCase.id}/proposals`)
        .expect(404);
      await w.h.as(w.laura).get(`/cases/${randomUUID()}`).expect(404);
      await w.h.as(w.laura).get('/cases/not-a-uuid').expect(400);
    });

    it('exposes no PATCH or DELETE on cases', async () => {
      const own = await newCase(w.laura);
      await w.h
        .as(w.laura)
        .patch(`/cases/${own.id}`, { status: 'completed' })
        .expect(404);
      await request(w.h.app.getHttpServer())
        .delete(`/api/v1/cases/${own.id}`)
        .set('Authorization', `Bearer ${w.h.tokenFor(w.laura)}`)
        .expect(404);
      expect(
        (await w.h.as(w.laura).get(`/cases/${own.id}`).expect(200)).body.status,
      ).toBe('received');
    });
  });

  describe('transactional audit', () => {
    let failing: TestApp;

    beforeAll(async () => {
      const reject = () =>
        Promise.reject(new Error('audit storage unavailable'));
      failing = await createTestApp(w.t.db, (b) =>
        b.overrideProvider(AuditService).useValue({
          recordUserAction: reject,
          recordAutomatedAction: reject,
        }),
      );
    });

    afterAll(async () => {
      await failing.app.close();
    });

    it('rolls back the case and its job when auditing fails', async () => {
      const count = async () =>
        (
          await sql<{ c: string; j: string }>(
            'SELECT (SELECT count(*) FROM cases) AS c, (SELECT count(*) FROM workflow_jobs) AS j',
          )
        )[0];
      const before = await count();
      await failing
        .as(w.laura)
        .post('/cases', {
          type: 'household_obligation',
          requestId: randomUUID(),
        })
        .expect(500);
      expect(await count()).toEqual(before);
    });

    it('keeps audit events append-only', async () => {
      const own = await newCase(w.laura);
      await expect(
        sql(
          `UPDATE audit_events SET action = 'x' WHERE metadata->>'resourceId' = $1`,
          [own.id],
        ),
      ).rejects.toThrow();
      expect(await countAudit('case.create', own.id)).toBe(1);
    });
  });
});
