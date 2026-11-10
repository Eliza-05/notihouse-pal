import { randomUUID } from 'node:crypto';
import {
  type ClaimedJob,
  Harness,
  recordEvidence,
  type Res,
  statuses,
} from './support/harness.js';

const COMPLETE = (id: string) => `/internal/workflow-jobs/${id}/complete`;
const FAIL = (id: string) => `/internal/workflow-jobs/${id}/fail`;
const HEARTBEAT = (id: string) => `/internal/workflow-jobs/${id}/heartbeat`;
const jobsOf = (r: Res) => r.body.jobs as ClaimedJob[];

describe('Cola de trabajos en PostgreSQL real', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());
  beforeEach(() => h.drainQueue());

  describe('Escenario A — reclamaciones simultáneas', () => {
    it('SKIP LOCKED: con el trabajo tomado por A en curso, B no lo recibe', async () => {
      const user = await h.newUser();
      const c = await h.newCase(user);
      // A bloquea la fila del trabajo y queda detenido en el bloqueo del caso:
      // las dos reclamaciones se solapan con certeza.
      const control = await h.owner.connect();
      await control.query('BEGIN');
      await control.query(`SELECT 1 FROM cases WHERE id = $1 FOR UPDATE`, [
        c.id,
      ]);
      const pendingA = h.claim('worker-a', { limit: 5 }, h.apiA);
      const blocked = await h.waitBlocked(1);
      const b = await h.claim('worker-b', { limit: 5 }, h.apiB);
      await control.query('ROLLBACK');
      control.release();
      const a = await pendingA;

      expect(jobsOf(b)).toEqual([]);
      expect(jobsOf(a).map((j) => j.case.id)).toEqual([c.id]);
      const [job] = jobsOf(a);
      const row = await h.job(job!.id);
      expect(row.status).toBe('claimed');
      expect(row.attempts).toBe(1);
      expect(await h.audit('workflow_job.claim', job!.id)).toBe(1);
      recordEvidence('claim-skip-locked', {
        blockedApi: blocked[0]!.application_name,
        workerBJobs: jobsOf(b).length,
        workerAJobs: jobsOf(a).length,
      });
    });

    it('12 reclamaciones simultáneas por dos instancias: un solo titular', async () => {
      const user = await h.newUser();
      const c = await h.newCase(user);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          h.claim(`w-${i}`, { limit: 10 }, i % 2 ? h.apiA : h.apiB),
        ),
      );
      expect(new Set(statuses(results))).toEqual(new Set([200]));
      const holders = results.flatMap(jobsOf).filter((j) => j.case.id === c.id);
      expect(holders).toHaveLength(1);
      expect((await h.job(holders[0]!.id)).attempts).toBe(1);
      expect(await h.audit('workflow_job.claim', holders[0]!.id)).toBe(1);
    });

    it('lotes simultáneos reparten trabajos sin repetir ninguno', async () => {
      const user = await h.newUser();
      const ids = new Set<string>();
      for (let i = 0; i < 24; i++) ids.add((await h.newCase(user)).id);
      const results = await Promise.all(
        [2, 3, 5, 10, 10, 10].map((limit, i) =>
          h.claim(`batch-${i}`, { limit }, i % 2 ? h.apiA : h.apiB),
        ),
      );
      const claimed = results.flatMap(jobsOf);
      const jobIds = claimed.map((j) => j.id);
      expect(new Set(jobIds).size).toBe(jobIds.length);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(claimed.every((j) => ids.has(j.case.id))).toBe(true);
      expect(claimed.every((j) => j.attempts === 1)).toBe(true);
      const again = await h.count(
        `SELECT count(*) AS n FROM workflow_jobs WHERE status = 'claimed' AND attempts <> 1`,
      );
      expect(again).toBe(0);
      recordEvidence('claim-batches', {
        requested: [2, 3, 5, 10, 10, 10],
        received: results.map((r) => jobsOf(r).length),
        distinctJobs: jobIds.length,
      });
    });

    it('excluye no disponibles, terminados, agotados y de casos cerrados', async () => {
      const user = await h.newUser();
      const future = await h.newCase(user);
      await h.sql(
        `UPDATE workflow_jobs SET available_at = now() + interval '1 hour' WHERE case_id = $1`,
        [future.id],
      );
      const done = await h.claimedCase(user);
      await h.apiA.service.post(COMPLETE(done.job.id), {
        claimToken: done.job.claimToken,
      });
      const failed = await h.claimedCase(user);
      await h.apiA.service.post(FAIL(failed.job.id), {
        claimToken: failed.job.claimToken,
        error: 'definitivo',
        retryable: false,
      });
      const exhausted = await h.newCase(user);
      await h.sql(
        `UPDATE workflow_jobs SET attempts = max_attempts WHERE case_id = $1`,
        [exhausted.id],
      );
      const closed = await h.newCase(user);
      await h.sql(
        `UPDATE cases SET status = 'failed', closed_at = now(), status_reason = 'fixture' WHERE id = $1`,
        [closed.id],
      );
      const res = await h.claim('sweeper', { limit: 10 });
      expect(jobsOf(res)).toEqual([]);
    });

    it('dos reclamaciones con casos cruzados no se interbloquean', async () => {
      // Dos trabajos por caso. Tras la barrera A quiere los casos X→Y y B Y→X:
      // sin un orden global de bloqueo, PostgreSQL mata a una con 40P01.
      const user = await h.newUser();
      const x = await h.newCase(user);
      const y = await h.newCase(user);
      await h.sql(
        `INSERT INTO workflow_jobs (case_id, job_type, idempotency_key)
         VALUES ($1, 'test.extra', $3), ($2, 'test.extra', $4)`,
        [x.id, y.id, randomUUID(), randomUUID()],
      );
      // Orden de reclamación: x1, y1 (para A); y2, x2 (para B).
      const order = async (caseId: string, type: string, ms: number) =>
        h.sql(
          `UPDATE workflow_jobs SET available_at = now() - interval '1 hour' + make_interval(secs => $3::float8 / 1000)
            WHERE case_id = $1 AND job_type = $2`,
          [caseId, type, ms],
        );
      await order(x.id, 'case.household_obligation', 0);
      await order(y.id, 'case.household_obligation', 1);
      await order(y.id, 'test.extra', 2);
      await order(x.id, 'test.extra', 3);

      const deadlocksBefore = await h.count(
        `SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`,
      );
      const control = await h.owner.connect();
      await control.query('BEGIN');
      await control.query(`SELECT 1 FROM cases WHERE id = $1 FOR UPDATE`, [
        x.id,
      ]);
      const a = h.claim('worker-a', { limit: 2 }, h.apiA);
      await h.waitBlocked(1);
      const b = h.claim('worker-b', { limit: 2 }, h.apiB);
      await h.waitBlocked(2);
      await control.query('ROLLBACK');
      control.release();
      const results = await Promise.all([a, b]);

      recordEvidence('claim-crossed-cases', {
        statuses: statuses(results),
        deadlocksBefore,
      });
      expect(statuses(results)).toEqual([200, 200]);
      const all = results.flatMap(jobsOf);
      expect(new Set(all.map((j) => j.id)).size).toBe(4);
    });

    it('un caso cerrado mientras se reclama no entrega el trabajo', async () => {
      const user = await h.newUser();
      const c = await h.newCase(user);
      const control = await h.owner.connect();
      await control.query('BEGIN');
      await control.query(
        `UPDATE cases SET status = 'failed', closed_at = now(), status_reason = 'cierre concurrente' WHERE id = $1`,
        [c.id],
      );
      const pending = h.claim('worker-a', { limit: 5 });
      await h.waitBlocked(1);
      await control.query('COMMIT');
      control.release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(jobsOf(res)).toEqual([]);
      const [job] = await h.sql(
        `SELECT status, attempts FROM workflow_jobs WHERE case_id = $1`,
        [c.id],
      );
      expect(job!.status).toBe('cancelled');
    });
  });

  describe('Escenario B — arrendamientos y fencing', () => {
    it('el worker antiguo recibe 409; el vigente completa; nada se sobrescribe', async () => {
      const user = await h.newUser();
      const { c, job: old } = await h.claimedCase(user);
      await h.expireLease(old.id);
      const current = await h.claimOf(c.id, 'worker-new');
      expect(current.id).toBe(old.id);
      expect(current.attempts).toBe(2);

      const { results, blocked } = await h.behindLock(
        'fencing-stale-vs-current',
        { table: 'workflow_jobs', id: old.id },
        2,
        () => [
          h.apiA.service.post(COMPLETE(old.id), {
            claimToken: old.claimToken,
            result: { from: 'antiguo' },
          }),
          h.apiB.service.post(COMPLETE(old.id), {
            claimToken: current.claimToken,
            result: { from: 'vigente' },
          }),
        ],
      );
      expect(new Set(blocked.map((b) => b.pid)).size).toBe(2);
      expect(results[0]!.status).toBe(409);
      expect(results[1]!.status).toBe(200);
      const row = await h.job(old.id);
      expect(row.result).toEqual({ from: 'vigente' });
      expect(row.status).toBe('completed');
      expect(row.attempts).toBe(2);
      expect(await h.audit('workflow_job.complete', old.id)).toBe(1);
      const [event] = await h.sql(
        `SELECT actor_id FROM audit_events WHERE action = 'workflow_job.complete' AND metadata->>'resourceId' = $1`,
        [old.id],
      );
      expect(event!.actor_id).toBe('n8n:worker-new');
    });

    it.each([
      ['heartbeat', HEARTBEAT, {}],
      ['complete', COMPLETE, { result: { a: 1 } }],
      ['fail', FAIL, { error: 'tarde' }],
    ])(
      '%s de una reclamación vencida responde 409',
      async (_n, route, body) => {
        const user = await h.newUser();
        const { job } = await h.claimedCase(user);
        await h.expireLease(job.id);
        const before = await h.job(job.id);
        const res = await h.apiA.service.post(route(job.id), {
          claimToken: job.claimToken,
          ...body,
        });
        expect(res.status).toBe(409);
        const after = await h.job(job.id);
        expect(after.status).toBe('claimed');
        expect(after.locked_until).toEqual(before.locked_until);
        expect(after.result).toBeNull();
      },
    );

    it('dos heartbeats concurrentes renuevan sin transición ni auditoría', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const before = await h.job(job.id);
      const { results } = await h.behindLock(
        'heartbeat-heartbeat',
        { table: 'workflow_jobs', id: job.id },
        2,
        () =>
          [h.apiA, h.apiB].map((api) =>
            api.service.post(HEARTBEAT(job.id), {
              claimToken: job.claimToken,
              leaseSeconds: 600,
            }),
          ),
      );
      expect(statuses(results)).toEqual([200, 200]);
      const after = await h.job(job.id);
      expect(after.status).toBe('claimed');
      expect(after.attempts).toBe(before.attempts);
      expect(after.locked_until.getTime()).toBeGreaterThan(
        before.locked_until.getTime(),
      );
      expect(await h.audit('workflow_job.claim', job.id)).toBe(1);
    });

    it('heartbeat y complete a la vez: siempre termina completado y coherente', async () => {
      for (const order of [0, 1]) {
        const user = await h.newUser();
        const { job } = await h.claimedCase(user);
        const calls = [
          () =>
            h.apiA.service.post(HEARTBEAT(job.id), {
              claimToken: job.claimToken,
            }),
          () =>
            h.apiB.service.post(COMPLETE(job.id), {
              claimToken: job.claimToken,
              result: { ok: true },
            }),
        ];
        const { results } = await h.behindLock(
          'heartbeat-complete',
          { table: 'workflow_jobs', id: job.id },
          2,
          () => (order ? [...calls].reverse() : calls).map((f) => f()),
        );
        const complete = order ? results[0]! : results[1]!;
        const heartbeat = order ? results[1]! : results[0]!;
        expect(complete.status).toBe(200);
        expect([200, 409]).toContain(heartbeat.status);
        const row = await h.job(job.id);
        expect(row.status).toBe('completed');
        expect(row.locked_until).toBeNull();
        expect(await h.audit('workflow_job.complete', job.id)).toBe(1);
      }
    });

    it('un heartbeat abortado por el cliente no deja la sesión ni el trabajo inconsistentes', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const abort = new AbortController();
      const control = await h.owner.connect();
      await control.query('BEGIN');
      await control.query(
        `SELECT 1 FROM workflow_jobs WHERE id = $1 FOR UPDATE`,
        [job.id],
      );
      const pending = h.apiA.service
        .post(
          HEARTBEAT(job.id),
          { claimToken: job.claimToken },
          { signal: abort.signal },
        )
        .catch((e: Error) => e.name);
      await h.waitBlocked(1);
      abort.abort();
      expect(await pending).toBe('AbortError');
      await control.query('ROLLBACK');
      control.release();
      // La transacción del servidor termina y devuelve su conexión al pool.
      await expect
        .poll(
          () =>
            h.count(
              `SELECT count(*) AS n FROM pg_stat_activity
                WHERE application_name LIKE 'notihouse-pal-api%' AND state <> 'idle'`,
            ),
          { timeout: 5_000 },
        )
        .toBe(0);
      const ok = await h.apiA.service.post(COMPLETE(job.id), {
        claimToken: job.claimToken,
      });
      expect(ok.status).toBe(200);
    });

    it('sin intentos restantes el arrendamiento vencido cierra el trabajo y el caso', async () => {
      const user = await h.newUser();
      const { c, job } = await h.claimedCase(user);
      await h.sql(
        `UPDATE workflow_jobs SET max_attempts = 1, locked_until = now() - interval '1 second' WHERE id = $1`,
        [job.id],
      );
      const res = await h.claim('rescuer', { limit: 5 });
      expect(jobsOf(res)).toEqual([]);
      const row = await h.job(job.id);
      expect(row.status).toBe('failed');
      expect(row.locked_until).toBeNull();
      const [caseRow] = await h.sql(`SELECT status FROM cases WHERE id = $1`, [
        c.id,
      ]);
      expect(caseRow!.status).toBe('failed');
      const stale = await h.apiA.service.post(COMPLETE(job.id), {
        claimToken: job.claimToken,
      });
      expect(stale.status).toBe(409);
    });
  });

  describe('Escenario C — complete duplicado y contradictorio', () => {
    const complete = (job: ClaimedJob, result?: object) =>
      h.apiA.service.post(COMPLETE(job.id), {
        claimToken: job.claimToken,
        ...(result ? { result } : {}),
      });

    it('repetición idéntica: 200, mismo resultado, sin evento nuevo', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const first = await complete(job, { pages: 1, nested: { b: 2, a: 1 } });
      expect(first.status).toBe(200);
      const before = await h.job(job.id);
      const again = await complete(job, { nested: { a: 1, b: 2 }, pages: 1.0 });
      expect(again.status).toBe(200);
      expect(again.body.result).toEqual({ pages: 1, nested: { a: 1, b: 2 } });
      const after = await h.job(job.id);
      expect(after.updated_at).toEqual(before.updated_at);
      expect(after.completed_at).toEqual(before.completed_at);
      expect(await h.audit('workflow_job.complete', job.id)).toBe(1);
    });

    it.each<[string, object | undefined, object]>([
      ['valor distinto', { pages: 1 }, { pages: 2 }],
      ['tipo distinto', { pages: 1 }, { pages: '1' }],
      ['orden de arreglo distinto', { l: [1, 2] }, { l: [2, 1] }],
      ['clave adicional', { pages: 1 }, { pages: 1, x: null }],
      ['resultado omitido al inicio', undefined, { pages: 1 }],
    ])('repetición contradictoria (%s): 409 sin cambios', async (_n, a, b) => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      expect((await complete(job, a)).status).toBe(200);
      const before = await h.job(job.id);
      const res = await complete(job, b);
      expect(res.status).toBe(409);
      const after = await h.job(job.id);
      expect(after.result).toEqual(before.result);
      expect(after.updated_at).toEqual(before.updated_at);
      expect(after.status).toBe('completed');
      expect(await h.audit('workflow_job.complete', job.id)).toBe(1);
    });

    it('worker antiguo: rechazado aunque el resultado coincida', async () => {
      const user = await h.newUser();
      const { c, job: old } = await h.claimedCase(user);
      await h.expireLease(old.id);
      const current = await h.claimOf(c.id, 'worker-new');
      expect((await complete(current, { same: true })).status).toBe(200);
      expect((await complete(old, { same: true })).status).toBe(409);
      expect(await h.audit('workflow_job.complete', old.id)).toBe(1);
    });

    it('completar un trabajo fallido o cancelado se rechaza', async () => {
      const user = await h.newUser();
      const failed = await h.claimedCase(user);
      await h.apiA.service.post(FAIL(failed.job.id), {
        claimToken: failed.job.claimToken,
        error: 'x',
        retryable: false,
      });
      expect((await complete(failed.job)).status).toBe(409);
      const cancelled = await h.claimedCase(user);
      await h.sql(
        `UPDATE workflow_jobs SET status = 'cancelled', locked_until = NULL WHERE id = $1`,
        [cancelled.job.id],
      );
      expect((await complete(cancelled.job)).status).toBe(409);
    });

    it('complete simultáneos idénticos: 200 todos y una sola transición', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const { results } = await h.behindLock(
        'complete-identical',
        { table: 'workflow_jobs', id: job.id },
        4,
        () =>
          [h.apiA, h.apiB, h.apiA, h.apiB].map((api) =>
            api.service.post(COMPLETE(job.id), {
              claimToken: job.claimToken,
              result: { same: 1 },
            }),
          ),
      );
      expect(statuses(results)).toEqual([200, 200, 200, 200]);
      expect(await h.audit('workflow_job.complete', job.id)).toBe(1);
    });

    it('complete simultáneos contradictorios: uno gana y el otro recibe 409', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const { results } = await h.behindLock(
        'complete-contradictory',
        { table: 'workflow_jobs', id: job.id },
        2,
        () =>
          [1, 2].map((n) =>
            (n === 1 ? h.apiA : h.apiB).service.post(COMPLETE(job.id), {
              claimToken: job.claimToken,
              result: { n },
            }),
          ),
      );
      expect(statuses(results)).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      expect((await h.job(job.id)).result).toEqual(winner.body.result);
      expect(await h.audit('workflow_job.complete', job.id)).toBe(1);
    });
  });

  describe('Escenario D — fallos y reintentos', () => {
    const fail = (job: ClaimedJob, body: object = {}) =>
      h.apiA.service.post(FAIL(job.id), {
        claimToken: job.claimToken,
        error: 'proveedor no disponible',
        ...body,
      });

    it('backoff exponencial, reintentos y cierre definitivo sin bucles', async () => {
      const user = await h.newUser();
      const c = await h.newCase(user);
      const delays: number[] = [];
      let job = await h.claimOf(c.id, 'w0');
      for (let attempt = 1; attempt <= 5; attempt++) {
        expect(job.attempts).toBe(attempt);
        const res = await fail(job);
        expect(res.status).toBe(200);
        const [row] = await h.sql(
          `SELECT status, attempts, EXTRACT(EPOCH FROM (available_at - now()))::float8 AS wait FROM workflow_jobs WHERE id = $1`,
          [job.id],
        );
        if (attempt < 5) {
          expect(row!.status).toBe('pending');
          delays.push(Math.round(row!.wait as number));
          // Todavía no está disponible: el backoff se respeta.
          expect(jobsOf(await h.claim('early', { limit: 5 }))).toEqual([]);
          await h.makeAvailable(job.id);
          job = await h.claimOf(c.id, `w${attempt}`);
        } else {
          expect(row!.status).toBe('failed');
        }
      }
      expect(delays).toEqual([30, 60, 120, 240]);
      const [caseRow] = await h.sql(`SELECT status FROM cases WHERE id = $1`, [
        c.id,
      ]);
      expect(caseRow!.status).toBe('failed');
      expect(jobsOf(await h.claim('late', { limit: 5 }))).toEqual([]);
      expect(await h.audit('workflow_job.fail', job.id)).toBe(5);
      expect(await h.audit('workflow_job.claim', job.id)).toBe(5);
    });

    it('fallo duplicado y fallos concurrentes cuentan una vez', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const { results } = await h.behindLock(
        'fail-fail',
        { table: 'workflow_jobs', id: job.id },
        2,
        () => [fail(job), fail(job, { error: 'otro texto' })],
      );
      expect(statuses(results)).toEqual([200, 200]);
      expect((await fail(job)).status).toBe(200);
      expect((await h.job(job.id)).attempts).toBe(1);
      expect(await h.audit('workflow_job.fail', job.id)).toBe(1);
    });

    it('complete y fail a la vez: un único estado terminal coherente', async () => {
      for (const first of ['complete', 'fail']) {
        const user = await h.newUser();
        const { job } = await h.claimedCase(user);
        const calls = {
          complete: () =>
            h.apiA.service.post(COMPLETE(job.id), {
              claimToken: job.claimToken,
              result: { ok: 1 },
            }),
          fail: () =>
            h.apiB.service.post(FAIL(job.id), {
              claimToken: job.claimToken,
              error: 'x',
              retryable: false,
            }),
        };
        const { results } = await h.behindLock(
          'complete-vs-fail',
          { table: 'workflow_jobs', id: job.id },
          2,
          () =>
            first === 'complete'
              ? [calls.complete(), calls.fail()]
              : [calls.fail(), calls.complete()],
        );
        expect(statuses(results)).toEqual([200, 409]);
        const row = await h.job(job.id);
        const events =
          (await h.audit('workflow_job.complete', job.id)) +
          (await h.audit('workflow_job.fail', job.id));
        expect(events).toBe(1);
        expect(['completed', 'failed']).toContain(row.status);
        expect(row.completed_at !== null).toBe(row.status === 'completed');
      }
    });

    it('el estado terminal no se sobrescribe por respuestas posteriores', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      await h.apiA.service.post(COMPLETE(job.id), {
        claimToken: job.claimToken,
      });
      expect((await fail(job)).status).toBe(409);
      expect((await h.job(job.id)).status).toBe('completed');
    });
  });
});
