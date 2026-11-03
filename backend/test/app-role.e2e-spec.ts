import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createTestClock, withClock } from './support/clock.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import { samplePdf } from './support/sample-files.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const ADMIN_DIR = fileURLToPath(
  new URL('../../database/admin/', import.meta.url),
);

/**
 * La API completa ejecutándose con la sesión de PostgreSQL en el rol
 * restringido `notihouse_app` (database/admin/02-grant-app-privileges.sql).
 * Demuestra que el inventario de privilegios basta para los flujos reales.
 * PGlite: una sola conexión; no sustituye la verificación en Neon.
 */
describe('API under the restricted application role (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let laura: TestUser;
  let andres: TestUser;

  beforeAll(async () => {
    t = await createMigratedDatabase();
    for (const file of [
      '01-create-app-role.sql',
      '02-grant-app-privileges.sql',
    ]) {
      await t.client.exec(readFileSync(`${ADMIN_DIR}${file}`, 'utf8'));
    }
    // Las cuentas las crea el propietario (como el seed); la API no puede.
    const pw = () => randomBytes(12).toString('base64url');
    laura = await createTestUser(t.db, {
      email: 'laura@role.test',
      password: pw(),
      displayName: 'laura',
    });
    andres = await createTestUser(t.db, {
      email: 'andres@role.test',
      password: pw(),
      displayName: 'andres',
    });
    await t.client.exec('SET ROLE notihouse_app');
    h = await createTestApp(t.db, withClock(createTestClock()));
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
  });

  it('runs as notihouse_app', async () => {
    const { rows } = await t.client.query<{ u: string }>(
      'SELECT current_user AS u',
    );
    expect(rows[0]!.u).toBe('notihouse_app');
  });

  it('logs in and serves business flows with human confirmations', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: laura.email, password: laura.password })
      .expect(200);
    const token = res.body.accessToken as string;
    await request(h.app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const L = h.as(laura);
    const property = (await L.post('/properties', { name: 'Apto' }).expect(201))
      .body.id;
    await L.patch(`/properties/${property}`, { description: 'x' }).expect(200);
    const obligation = (
      await L.post('/obligations', {
        providerName: 'Energía SA',
        concept: 'Energía',
        category: 'electricity',
        expectedAmount: '100.00',
        propertyId: property,
      }).expect(201)
    ).body.id;
    const occ = (
      await L.post(`/obligations/${obligation}/occurrences`, {
        periodStart: '2030-01-01',
        periodEnd: '2030-01-31',
        dueDate: '2030-01-18',
      }).expect(201)
    ).body.id;
    await L.post(`/obligations/${obligation}/occurrences/${occ}/confirm`, {
      result: 'paid',
    }).expect(200);

    const A = h.as(andres);
    const aProperty = (await A.post('/properties', { name: 'Local' })).body.id;
    const rental = (
      await A.post('/rentals', {
        propertyId: aProperty,
        expectedAmount: '900.00',
        dueDay: 5,
        startsOn: '2030-01-01',
      }).expect(201)
    ).body.id;
    const charge = (
      await A.post(`/rentals/${rental}/charges`, {
        periodStart: '2030-01-01',
        periodEnd: '2030-01-31',
        dueDate: '2030-01-05',
      }).expect(201)
    ).body.id;
    await A.post(`/rentals/${rental}/charges/${charge}/confirm`, {
      evidence: 'Transferencia',
    }).expect(200);
    const contract = (
      await A.post('/contracts', {
        propertyId: aProperty,
        rentalId: rental,
        startsOn: '2030-01-01',
        endsOn: '2030-12-31',
      }).expect(201)
    ).body.id;
    await A.patch(`/contracts/${contract}`, { noticePeriodDays: 30 }).expect(
      200,
    );
    // Aislamiento intacto bajo el rol restringido.
    await A.get(`/obligations/${obligation}`).expect(404);
  });

  it('runs the automation flow: case, claim, proposal, HITL, decision and application', async () => {
    const L = h.as(laura);
    const svc = h.asService();
    const obligation = (
      await L.post('/obligations', {
        providerName: 'Agua SA',
        concept: 'Agua',
        category: 'water',
      }).expect(201)
    ).body.id;
    const c = (
      await L.post('/cases', {
        type: 'household_obligation',
        obligationId: obligation,
      }).expect(201)
    ).body;
    const [job] = (
      await svc.post('/internal/workflow-jobs/claim', { workerId: 'w1' })
    ).body.jobs;
    await svc
      .post(`/internal/workflow-jobs/${job.id}/heartbeat`, {
        claimToken: job.claimToken,
      })
      .expect(200);
    const ref = { jobId: job.id, claimToken: job.claimToken };
    const proposal = (
      await svc
        .post(`/internal/cases/${c.id}/proposals`, {
          ...ref,
          source: 'llm',
          proposedData: {
            action: 'create_obligation_occurrence',
            data: {
              obligationId: obligation,
              periodStart: '2030-02-01',
              periodEnd: '2030-02-28',
              dueDate: '2030-02-15',
              amount: '50.00',
            },
          },
        })
        .expect(201)
    ).body;
    const review = (
      await svc
        .post(`/internal/cases/${c.id}/hitl-requests`, {
          ...ref,
          decisionType: 'data_confirmation',
          proposalId: proposal.id,
          options: { summary: 'Confirma' },
        })
        .expect(201)
    ).body;
    await L.post(`/hitl-requests/${review.id}/decision`, {
      decision: 'approved',
    }).expect(200);
    await L.post(`/cases/${c.id}/proposals/${proposal.id}/apply`).expect(201);
    await svc
      .post(`/internal/workflow-jobs/${job.id}/complete`, {
        claimToken: job.claimToken,
      })
      .expect(200);
    await svc
      .post('/internal/hitl-requests/expire', { workerId: 'w1' })
      .expect(200);
  });

  it('ingests, downloads and serves a document to the claiming worker', async () => {
    const upload = await request(h.app.getHttpServer())
      .post('/api/v1/ingestions/documents')
      .set('Authorization', `Bearer ${h.tokenFor(laura)}`)
      .attach('file', samplePdf(`Factura ${randomUUID()}`), {
        filename: 'f.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    await h
      .as(laura)
      .get(`/documents/${upload.body.documentId}/content`)
      .expect(200);
    const jobs = (
      await h
        .asService()
        .post('/internal/workflow-jobs/claim', {
          workerId: 'w2',
          jobTypes: ['document.process'],
        })
        .expect(200)
    ).body.jobs;
    const job = jobs.find(
      (j: { case: { id: string } }) => j.case.id === upload.body.caseId,
    );
    await request(h.app.getHttpServer())
      .get(`/api/v1/internal/documents/${upload.body.documentId}/content`)
      .set('Authorization', `Bearer ${process.env.N8N_SERVICE_TOKEN}`)
      .set('X-Job-Id', job.id)
      .set('X-Claim-Token', job.claimToken)
      .expect(200);
    await h
      .asService()
      .post(`/internal/workflow-jobs/${job.id}/fail`, {
        claimToken: job.claimToken,
        error: 'OCR no disponible',
        retryable: true,
      })
      .expect(200);
  });

  it('evaluates alerts and serves the inbox and dashboard', async () => {
    await h
      .asService()
      .post('/internal/alerts/evaluate', { workerId: 'scheduler' })
      .expect(200);
    const alerts = (await h.as(laura).get('/alerts').expect(200)).body;
    if (alerts.items[0]) {
      await h.as(laura).post(`/alerts/${alerts.items[0].id}/read`).expect(200);
      await h
        .as(laura)
        .post(`/alerts/${alerts.items[0].id}/dismiss`)
        .expect(200);
    }
    await h.as(laura).get('/attention').expect(200);
    await h.as(andres).get('/dashboard/summary').expect(200);
    await h.as(laura).get('/hitl-requests').expect(200);
  });
});
