import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { type ClaimedJob, Harness, recordEvidence } from './support/harness.js';

/**
 * Etapa 7: kill switch en PostgreSQL 18 real con DOS instancias de la API
 * (conexiones independientes). Comprueba que el estado no vive en memoria de
 * un proceso y que las carreras no producen dobles activaciones.
 */
describe('Kill switch en PostgreSQL real (dos instancias)', () => {
  let h: Harness;
  const ks = () => h.apiA.app.get(KillSwitchService);
  const events = () =>
    h.count(
      `SELECT count(*) AS n FROM audit_events WHERE component = 'ops.kill-switch' AND action = 'kill_switch.activate'`,
    );
  const resumeAll = async () => {
    for (const scope of await ks().activeScopes()) {
      await ks().resume({
        scope,
        operator: 'suite-pg',
        reason: 'limpieza',
        testEvidence: 'suite pg',
      });
    }
  };
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(async () => {
    await resumeAll();
    await h.close();
  });
  beforeEach(async () => {
    await resumeAll();
    await h.drainQueue();
  });

  it('10 activaciones simultáneas desde dos instancias: un solo evento', async () => {
    const before = await events();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? h.apiA : h.apiB).service.post(
          '/internal/kill-switch/activate',
          {
            scope: 'document_processing',
            reason: `carrera ${i}`,
            workerId: `w-${i}`,
          },
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect((await events()) - before).toBe(1);
    recordEvidence('kill-switch-concurrent-activation', {
      requests: 10,
      events: (await events()) - before,
    });
  });

  it('la activación en la instancia A detiene reclamaciones y escrituras en la B', async () => {
    const user = await h.newUser();
    const inflight = await h.claimedCase(user);
    const pending = await h.newCase(user);
    const act = await h.apiA.service.post('/internal/kill-switch/activate', {
      scope: 'global',
      reason: 'incidente',
      workerId: 'operador',
    });
    expect(act.status).toBe(200);
    // Ninguna instancia entrega trabajos.
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        h.claim(`w-${i}`, { limit: 10 }, i % 2 ? h.apiA : h.apiB),
      ),
    );
    expect(claims.flatMap((r) => r.body.jobs as ClaimedJob[])).toEqual([]);
    const [row] = await h.sql<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM workflow_jobs WHERE case_id = $1`,
      [pending.id],
    );
    expect(row).toEqual({ status: 'pending', attempts: 0 });
    // La escritura del trabajo ya reclamado se rechaza en la otra instancia.
    const write = await h.apiB.service.post(
      `/internal/cases/${inflight.c.id}/proposals`,
      {
        jobId: inflight.job.id,
        claimToken: inflight.job.claimToken,
        source: 'llm',
        proposedData: { nota: 'x' },
      },
    );
    expect(write.status).toBe(503);
    expect(write.body.code).toBe('KILL_SWITCH_ACTIVE');
    recordEvidence('kill-switch-cross-instance', {
      claimsReturned: 0,
      inflightWrite: write.status,
    });
  });

  it('tres fallos críticos simultáneos en dos instancias activan el componente una sola vez', async () => {
    const user = await h.newUser();
    const jobs: ClaimedJob[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await h.newCase(user);
      await h.sql(
        `UPDATE workflow_jobs SET max_attempts = 1 WHERE case_id = $1`,
        [c.id],
      );
      jobs.push(await h.claimOf(c.id, `w-${i}`));
    }
    const before = await events();
    const results = await Promise.all(
      jobs.map((job, i) =>
        (i % 2 ? h.apiA : h.apiB).service.post(
          `/internal/workflow-jobs/${job.id}/fail`,
          { claimToken: job.claimToken, error: 'Gemini 503', retryable: true },
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    // La evaluación de la racha se serializa: la última transacción ve las
    // otras dos confirmadas y activa exactamente una vez.
    const active = await ks().isSuspended('case_processing');
    const delta = (await events()) - before;
    expect(active).toBe(true);
    expect(delta).toBe(1);
    recordEvidence('kill-switch-concurrent-critical-failures', {
      activated: active,
      events: delta,
    });
  });
});
