import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service.js';
import {
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * Cola de trabajos consumida por un worker simulado (n8n no se instala):
 * reclamación con SKIP LOCKED, arrendamiento con token de reclamación,
 * complete/fail idempotentes, reintentos acotados y separación del negocio.
 */
describe('Workflow job queue (e2e)', () => {
  let w: ProcessWorld;
  const {
    sql,
    countAudit,
    drainQueue,
    newCase,
    claim,
    expireLease,
    makeAvailable,
  } = processHelpers(() => w);
  const svc = () => w.h.asService();
  const jobPath = (id: string, action = '') =>
    `/internal/workflow-jobs/${id}${action ? `/${action}` : ''}`;

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);

  beforeEach(async () => {
    await drainQueue();
  });

  afterAll(async () => {
    await w.h.app.close();
    await w.t.client.close();
  });

  describe('claim', () => {
    it('claims a pending job, returns only authorized data and starts the case', async () => {
      const c = await newCase(w.laura, { obligationId: w.lauraObligation });
      const [job, ...rest] = await claim('worker-1');
      expect(rest).toEqual([]);
      expect(job).toMatchObject({
        jobType: 'case.household_obligation',
        status: 'claimed',
        attempts: 1,
        workerId: 'worker-1',
        case: {
          id: c.id,
          correlationId: c.correlationId,
          type: 'household_obligation',
          source: 'form',
          status: 'processing',
          obligationId: w.lauraObligation,
        },
      });
      expect(job!.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(job)).not.toContain(w.laura.profileId);
      expect(JSON.stringify(job)).not.toContain('ownerId');

      // En PostgreSQL solo queda la huella del token, nunca el token.
      const [row] = await sql<{ locked_by: string }>(
        'SELECT locked_by FROM workflow_jobs WHERE id = $1',
        [job!.id],
      );
      expect(row!.locked_by).toMatch(/^worker-1#[0-9a-f]{64}$/);
      expect(row!.locked_by).not.toContain(job!.claimToken);

      const audit = await sql<Record<string, unknown>>(
        `SELECT actor_type, actor_id, owner_id, correlation_id FROM audit_events WHERE action = 'workflow_job.claim' AND metadata->>'resourceId' = $1`,
        [job!.id],
      );
      expect(audit).toEqual([
        {
          actor_type: 'workflow',
          actor_id: 'n8n:worker-1',
          owner_id: w.laura.profileId,
          correlation_id: c.correlationId,
        },
      ]);
      expect(
        (await w.h.as(w.laura).get(`/cases/${c.id}`).expect(200)).body.status,
      ).toBe('processing');
    });

    it('respects the batch limit and never hands out the same job twice', async () => {
      for (let i = 0; i < 3; i++) await newCase(w.laura);
      const first = await claim('worker-1', { limit: 2 });
      const second = await claim('worker-2', { limit: 2 });
      const third = await claim('worker-3', { limit: 2 });
      expect([first.length, second.length, third.length]).toEqual([2, 1, 0]);
      const ids = [...first, ...second].map((j) => j.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('splits jobs between concurrent consumers without duplicates', async () => {
      for (let i = 0; i < 6; i++)
        await newCase(w.andres, { type: 'rent_collection' });
      const batches = await Promise.all(
        ['a', 'b', 'c'].map((wid) => claim(`worker-${wid}`, { limit: 4 })),
      );
      const ids = batches.flat().map((j) => j.id);
      expect(ids).toHaveLength(6);
      expect(new Set(ids).size).toBe(6);
    });

    it('filters by job type and ignores unavailable, completed and actively claimed jobs', async () => {
      await newCase(w.camila, { type: 'contract_review' });
      expect(
        await claim('worker-1', { jobTypes: ['case.rent_collection'] }),
      ).toEqual([]);
      const [job] = await claim('worker-1', {
        jobTypes: ['case.contract_review'],
      });
      // Reclamado con arrendamiento vigente: nadie más lo obtiene.
      expect(await claim('worker-2')).toEqual([]);
      await svc()
        .post(jobPath(job!.id, 'complete'), { claimToken: job!.claimToken })
        .expect(200);
      expect(await claim('worker-2')).toEqual([]);

      const later = await newCase(w.camila, { type: 'contract_review' });
      await sql(
        `UPDATE workflow_jobs SET available_at = now() + interval '1 hour' WHERE case_id = $1`,
        [later.id],
      );
      expect(await claim('worker-2')).toEqual([]);
    });

    it('does not claim jobs of closed cases', async () => {
      const c = await newCase(w.laura);
      await sql(
        `UPDATE cases SET status = 'failed', status_reason = 'cerrado en prueba', closed_at = now() WHERE id = $1`,
        [c.id],
      );
      expect(await claim('worker-1')).toEqual([]);
    });

    it.each([
      ['missing workerId', {}],
      ['workerId with #', { workerId: 'a#b' }],
      ['limit too large', { workerId: 'w', limit: 11 }],
      ['lease too short', { workerId: 'w', leaseSeconds: 5 }],
      ['lease too long', { workerId: 'w', leaseSeconds: 3600 }],
      ['bad job type', { workerId: 'w', jobTypes: ['DROP TABLE'] }],
      ['client owner', { workerId: 'w', ownerId: randomUUID() }],
    ])('rejects an invalid claim (%s) with 400', async (_c, body) => {
      await svc().post('/internal/workflow-jobs/claim', body).expect(400);
    });
  });

  describe('lease and job details', () => {
    it('shows job details only with the current claim token', async () => {
      await newCase(w.laura);
      const [job] = await claim('worker-1');
      const ok = await svc()
        .get(jobPath(job!.id))
        .set('X-Claim-Token', job!.claimToken)
        .expect(200);
      expect(ok.body.id).toBe(job!.id);
      expect(ok.body).not.toHaveProperty('claimToken');
      await svc().get(jobPath(job!.id)).expect(400);
      await svc()
        .get(jobPath(job!.id))
        .set('X-Claim-Token', 'A'.repeat(43))
        .expect(409);
      await svc()
        .get(jobPath(randomUUID()))
        .set('X-Claim-Token', job!.claimToken)
        .expect(404);
    });

    it('renews the lease with a heartbeat, but not after it expired', async () => {
      await newCase(w.laura);
      const [job] = await claim('worker-1', { leaseSeconds: 30 });
      const renewed = await svc()
        .post(jobPath(job!.id, 'heartbeat'), {
          claimToken: job!.claimToken,
          leaseSeconds: 600,
        })
        .expect(200);
      expect(new Date(renewed.body.lockedUntil).getTime()).toBeGreaterThan(
        new Date(job!.lockedUntil).getTime(),
      );
      await expireLease(job!.id);
      await svc()
        .post(jobPath(job!.id, 'heartbeat'), { claimToken: job!.claimToken })
        .expect(409);
    });
  });

  describe('complete', () => {
    it('completes once; an identical repeat is idempotent and a contradictory one answers 409', async () => {
      await newCase(w.laura);
      const [job] = await claim('worker-1');
      const path = jobPath(job!.id, 'complete');
      const first = await svc()
        .post(path, { claimToken: job!.claimToken, result: { summary: 'ok' } })
        .expect(200);
      expect(first.body).toMatchObject({
        status: 'completed',
        result: { summary: 'ok' },
        lockedUntil: null,
        workerId: 'worker-1',
      });
      await svc()
        .post(path, {
          claimToken: job!.claimToken,
          result: { summary: 'otro' },
        })
        .expect(409);
      const again = await svc()
        .post(path, {
          claimToken: job!.claimToken,
          result: { summary: 'ok' },
        })
        .expect(200);
      expect(again.body.completedAt).toBe(first.body.completedAt);
      expect(again.body.result).toEqual({ summary: 'ok' });
      expect(await countAudit('workflow_job.complete', job!.id)).toBe(1);
      // Tras completar, la misma reclamación no puede reportar un fallo.
      await svc()
        .post(jobPath(job!.id, 'fail'), {
          claimToken: job!.claimToken,
          error: 'x',
        })
        .expect(409);
    });

    it('rejects an unknown claim token and an expired lease', async () => {
      await newCase(w.laura);
      const [job] = await claim('worker-1');
      const path = jobPath(job!.id, 'complete');
      const wrong = await svc()
        .post(path, { claimToken: 'B'.repeat(43) })
        .expect(409);
      expect(wrong.body.message).toBe(
        'La reclamación no es válida o fue reemplazada por otra',
      );
      await expireLease(job!.id);
      const expired = await svc()
        .post(path, { claimToken: job!.claimToken })
        .expect(409);
      expect(expired.body.message).toMatch(/venció/);
      expect(
        (
          await sql<{ status: string }>(
            'SELECT status FROM workflow_jobs WHERE id = $1',
            [job!.id],
          )
        )[0]!.status,
      ).toBe('claimed');
    });

    it('does not let a stale claim overwrite the result of a newer claim', async () => {
      await newCase(w.laura);
      const [old] = await claim('worker-1');
      await expireLease(old!.id);
      const [current] = await claim('worker-1'); // mismo worker, nueva reclamación
      expect(current!.id).toBe(old!.id);
      expect(current!.attempts).toBe(2);
      expect(current!.claimToken).not.toBe(old!.claimToken);

      await svc()
        .post(jobPath(old!.id, 'complete'), {
          claimToken: old!.claimToken,
          result: { from: 'old' },
        })
        .expect(409);
      await svc()
        .post(jobPath(old!.id, 'fail'), {
          claimToken: old!.claimToken,
          error: 'old',
        })
        .expect(409);
      const done = await svc()
        .post(jobPath(current!.id, 'complete'), {
          claimToken: current!.claimToken,
          result: { from: 'current' },
        })
        .expect(200);
      expect(done.body.result).toEqual({ from: 'current' });
      await svc()
        .post(jobPath(old!.id, 'complete'), { claimToken: old!.claimToken })
        .expect(409);
    });

    it.each([
      ['missing claim token', { claimToken: undefined }],
      ['array result', { result: [1, 2] }],
      ['oversized result', { result: { blob: 'x'.repeat(17_000) } }],
      ['client status', { status: 'completed' }],
    ])('rejects an invalid completion (%s) with 400', async (_c, body) => {
      await newCase(w.laura);
      const [job] = await claim('worker-1');
      await svc()
        .post(jobPath(job!.id, 'complete'), {
          claimToken: job!.claimToken,
          ...body,
        })
        .expect(400);
    });

    it('never touches business data, whatever the result says', async () => {
      const c = await newCase(w.andres, {
        type: 'rent_collection',
        rentalId: w.andresRental,
      });
      const [job] = await claim('worker-1');
      expect(job!.case.id).toBe(c.id);
      await svc()
        .post(jobPath(job!.id, 'complete'), {
          claimToken: job!.claimToken,
          result: {
            action: 'confirm_rent_charge',
            chargeId: w.andresCharge,
            status: 'received',
          },
        })
        .expect(200);
      const charge = (
        await w.h
          .as(w.andres)
          .get(`/rentals/${w.andresRental}/charges/${w.andresCharge}`)
          .expect(200)
      ).body;
      expect(charge).toMatchObject({
        status: 'expected',
        confirmedAt: null,
        confirmedBy: null,
      });
    });
  });

  describe('fail and retries', () => {
    it('schedules a retry with backoff, sanitizes the error and ignores a duplicate fail', async () => {
      await newCase(w.laura);
      const [job] = await claim('worker-1');
      const path = jobPath(job!.id, 'fail');
      const secret = 'sk-live-0123456789abcdefghijklmnopqrstuv';
      const res = await svc()
        .post(path, {
          claimToken: job!.claimToken,
          error: `Gmail rejected Bearer ${secret}\napi_key=${secret}`,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'pending',
        attempts: 1,
        lockedUntil: null,
      });
      expect(res.body.lastError).not.toContain(secret);
      expect(new Date(res.body.availableAt).getTime()).toBeGreaterThan(
        Date.now() + 20_000,
      );

      const again = await svc()
        .post(path, { claimToken: job!.claimToken, error: 'otra vez' })
        .expect(200);
      expect(again.body).toMatchObject({
        attempts: 1,
        lastError: res.body.lastError,
      });
      expect(await countAudit('workflow_job.fail', job!.id)).toBe(1);

      // No disponible hasta que pase la espera.
      expect(await claim('worker-2')).toEqual([]);
      await makeAvailable(job!.id);
      const [retry] = await claim('worker-2');
      expect(retry).toMatchObject({ id: job!.id, attempts: 2 });
    });

    it('fails definitively when attempts are exhausted and closes the case', async () => {
      const c = await newCase(w.laura);
      await sql(
        `UPDATE workflow_jobs SET max_attempts = 2 WHERE case_id = $1`,
        [c.id],
      );
      for (let attempt = 1; attempt <= 2; attempt++) {
        const [job] = await claim('worker-1');
        expect(job!.attempts).toBe(attempt);
        const res = await svc()
          .post(jobPath(job!.id, 'fail'), {
            claimToken: job!.claimToken,
            error: 'timeout',
          })
          .expect(200);
        expect(res.body.status).toBe(attempt < 2 ? 'pending' : 'failed');
        await makeAvailable(job!.id);
      }
      expect(await claim('worker-1')).toEqual([]);
      const closed = (await w.h.as(w.laura).get(`/cases/${c.id}`).expect(200))
        .body;
      expect(closed).toMatchObject({ status: 'failed' });
      expect(closed.statusReason).toMatch(/falló de forma definitiva/);
      expect(closed.closedAt).not.toBeNull();
    });

    it('does not retry a non-retryable failure', async () => {
      await newCase(w.laura);
      const [job] = await claim('worker-1');
      const res = await svc()
        .post(jobPath(job!.id, 'fail'), {
          claimToken: job!.claimToken,
          error: 'Documento ilegible',
          retryable: false,
        })
        .expect(200);
      expect(res.body.status).toBe('failed');
    });

    it('fails a job whose lease expired with no attempts left on the next claim', async () => {
      const c = await newCase(w.laura);
      await sql(
        `UPDATE workflow_jobs SET max_attempts = 1 WHERE case_id = $1`,
        [c.id],
      );
      const [job] = await claim('worker-1');
      await expireLease(job!.id);
      expect(await claim('worker-2')).toEqual([]);
      const [row] = await sql<{ status: string; last_error: string }>(
        'SELECT status, last_error FROM workflow_jobs WHERE id = $1',
        [job!.id],
      );
      expect(row!.status).toBe('failed');
      expect(row!.last_error).toMatch(/no quedan intentos/);
      expect(
        (await w.h.as(w.laura).get(`/cases/${c.id}`).expect(200)).body.status,
      ).toBe('failed');
    });

    it('rejects an empty error message (400)', async () => {
      await newCase(w.laura);
      const [job] = await claim('worker-1');
      await svc()
        .post(jobPath(job!.id, 'fail'), {
          claimToken: job!.claimToken,
          error: '',
        })
        .expect(400);
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

    it('rolls back claim, complete and fail when auditing fails', async () => {
      await newCase(w.laura);
      await failing
        .asService()
        .post('/internal/workflow-jobs/claim', { workerId: 'worker-1' })
        .expect(500);
      const [job] = await claim('worker-1'); // sigue disponible
      expect(job!.attempts).toBe(1);

      await failing
        .asService()
        .post(jobPath(job!.id, 'complete'), { claimToken: job!.claimToken })
        .expect(500);
      await failing
        .asService()
        .post(jobPath(job!.id, 'fail'), {
          claimToken: job!.claimToken,
          error: 'x',
        })
        .expect(500);
      const [row] = await sql<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM workflow_jobs WHERE id = $1',
        [job!.id],
      );
      expect(row).toEqual({ status: 'claimed', attempts: 1 });
    });
  });
});
