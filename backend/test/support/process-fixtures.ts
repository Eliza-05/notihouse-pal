import { randomBytes } from 'node:crypto';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './pglite.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Entorno de los flujos caso → trabajo → propuesta → HITL sobre PGlite:
 * tres usuarios con datos de negocio propios y un cliente que simula a n8n.
 */
export interface ProcessWorld {
  t: TestDatabase;
  h: TestApp;
  laura: TestUser;
  andres: TestUser;
  camila: TestUser;
  lauraObligation: string;
  andresRental: string;
  andresCharge: string;
  camilaContract: string;
}

const pw = () => randomBytes(12).toString('base64url');

export async function createProcessWorld(): Promise<ProcessWorld> {
  const t = await createMigratedDatabase();
  const [laura, andres, camila] = await Promise.all(
    ['laura', 'andres', 'camila'].map((name) =>
      createTestUser(t.db, {
        email: `${name}@notihouse.test`,
        password: pw(),
        displayName: name,
      }),
    ),
  );
  const h = await createTestApp(t.db);

  const property = async (user: TestUser) =>
    (await h.as(user).post('/properties', { name: 'Inmueble' }).expect(201))
      .body.id as string;
  const lauraObligation = (
    await h
      .as(laura!)
      .post('/obligations', {
        providerName: 'Empresa de energía',
        concept: 'Energía',
        category: 'electricity',
        expectedAmount: '145000.00',
      })
      .expect(201)
  ).body.id as string;
  const andresProperty = await property(andres!);
  const andresRental = (
    await h
      .as(andres!)
      .post('/rentals', {
        propertyId: andresProperty,
        expectedAmount: '1200000.00',
        dueDay: 5,
        startsOn: '2026-01-01',
      })
      .expect(201)
  ).body.id as string;
  const andresCharge = (
    await h
      .as(andres!)
      .post(`/rentals/${andresRental}/charges`, {
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        dueDate: '2026-11-05',
      })
      .expect(201)
  ).body.id as string;
  const camilaProperty = await property(camila!);
  const camilaContract = (
    await h
      .as(camila!)
      .post('/contracts', {
        propertyId: camilaProperty,
        startsOn: '2025-12-16',
        endsOn: '2026-12-15',
      })
      .expect(201)
  ).body.id as string;

  return {
    t,
    h,
    laura: laura!,
    andres: andres!,
    camila: camila!,
    lauraObligation,
    andresRental,
    andresCharge,
    camilaContract,
  };
}

export interface ClaimedJob {
  id: string;
  claimToken: string;
  jobType: string;
  status: string;
  attempts: number;
  workerId: string | null;
  lockedUntil: string;
  case: { id: string; correlationId: string; status: string };
}

export function processHelpers(w: () => ProcessWorld) {
  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => (await w().t.client.query<T>(query, params)).rows;

  return {
    sql,
    countAudit: async (action: string, resourceId: string) =>
      Number(
        (
          await sql<{ n: string }>(
            `SELECT count(*) AS n FROM audit_events WHERE action = $1 AND metadata->>'resourceId' = $2`,
            [action, resourceId],
          )
        )[0]!.n,
      ),
    /** Aísla cada prueba de la cola: anula los trabajos que quedaron abiertos. */
    drainQueue: () =>
      sql(
        `UPDATE workflow_jobs SET status = 'cancelled', locked_until = NULL WHERE status IN ('pending', 'claimed')`,
      ),
    newCase: async (user: TestUser, body: object = {}) =>
      (
        await w()
          .h.as(user)
          .post('/cases', { type: 'household_obligation', ...body })
          .expect(201)
      ).body as { id: string; correlationId: string; status: string },
    claim: async (workerId = 'worker-1', body: object = {}) =>
      (
        await w()
          .h.asService()
          .post('/internal/workflow-jobs/claim', { workerId, ...body })
          .expect(200)
      ).body.jobs as ClaimedJob[],
    /** Simula el paso del tiempo: el arrendamiento del trabajo ya venció. */
    expireLease: (jobId: string) =>
      sql(
        `UPDATE workflow_jobs SET locked_until = now() - interval '1 second' WHERE id = $1`,
        [jobId],
      ),
    makeAvailable: (jobId: string) =>
      sql(
        `UPDATE workflow_jobs SET available_at = now() - interval '1 second' WHERE id = $1`,
        [jobId],
      ),
    /** Simula que pasaron más de 24 h desde la creación de la revisión. */
    makeOverdue: (hitlId: string) =>
      sql(
        `UPDATE hitl_requests SET created_at = now() - interval '25 hours', due_at = now() - interval '1 hour' WHERE id = $1`,
        [hitlId],
      ),
  };
}
