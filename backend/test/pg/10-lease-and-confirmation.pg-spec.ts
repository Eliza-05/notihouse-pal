import {
  type ClaimedJob,
  Harness,
  type Res,
  statuses,
} from './support/harness.js';

const COMPLETE = (id: string) => `/internal/workflow-jobs/${id}/complete`;
const FAIL = (id: string) => `/internal/workflow-jobs/${id}/fail`;
const HEARTBEAT = (id: string) => `/internal/workflow-jobs/${id}/heartbeat`;

describe('Fase 4.2F.2.1 en PostgreSQL real', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());
  beforeEach(() => h.drainQueue());

  /**
   * Retiene la operación en un bloqueo de otra conexión, deja vencer el
   * arrendamiento MIENTRAS espera (reloj real de PostgreSQL) y solo entonces
   * libera. `now()` de la transacción retenida sigue siendo anterior al
   * vencimiento; es exactamente la condición que se quiere comprobar.
   */
  const whileLeaseExpires = async (
    jobId: string,
    lock: { table: string; id: string },
    fire: () => Promise<Res>,
  ): Promise<Res> => {
    await h.sql(
      `UPDATE workflow_jobs SET locked_until = clock_timestamp() + interval '700 milliseconds' WHERE id = $1`,
      [jobId],
    );
    const control = await h.owner.connect();
    let pending: Promise<Res> | undefined;
    try {
      await control.query('BEGIN');
      await control.query(
        `SELECT 1 FROM ${control.escapeIdentifier(lock.table)} WHERE id = $1 FOR UPDATE`,
        [lock.id],
      );
      pending = fire();
      await h.waitBlocked(1);
      await expect
        .poll(
          () =>
            h.count(
              `SELECT count(*) AS n FROM workflow_jobs WHERE id = $1 AND locked_until <= clock_timestamp()`,
              [jobId],
            ),
          { timeout: 5_000, interval: 25 },
        )
        .toBe(1);
    } finally {
      await control.query('ROLLBACK').catch(() => undefined);
      control.release();
    }
    return pending;
  };

  /** Igual que la anterior, pero el arrendamiento sigue vigente al liberar. */
  const whileBlocked = async (
    lock: { table: string; id: string },
    fire: () => Promise<Res>,
  ): Promise<Res> => {
    const control = await h.owner.connect();
    let pending: Promise<Res> | undefined;
    try {
      await control.query('BEGIN');
      await control.query(
        `SELECT 1 FROM ${control.escapeIdentifier(lock.table)} WHERE id = $1 FOR UPDATE`,
        [lock.id],
      );
      pending = fire();
      await h.waitBlocked(1);
    } finally {
      await control.query('ROLLBACK').catch(() => undefined);
      control.release();
    }
    return pending;
  };

  const jobLock = (job: ClaimedJob) => ({
    table: 'workflow_jobs',
    id: job.id,
  });

  describe('Vencimiento del arrendamiento durante la espera de un bloqueo', () => {
    it.each<[string, (job: ClaimedJob) => [string, object]]>([
      [
        'complete',
        (job) => [
          COMPLETE(job.id),
          { claimToken: job.claimToken, result: { tarde: true } },
        ],
      ],
      [
        'heartbeat',
        (job) => [
          HEARTBEAT(job.id),
          { claimToken: job.claimToken, leaseSeconds: 300 },
        ],
      ],
      [
        'fail',
        (job) => [FAIL(job.id), { claimToken: job.claimToken, error: 'tarde' }],
      ],
    ])(
      '%s retenido hasta después del vencimiento: 409 sin efectos',
      async (name, build) => {
        const user = await h.newUser();
        const { c, job } = await h.claimedCase(user);
        const [path, body] = build(job);
        const res = await whileLeaseExpires(job.id, jobLock(job), () =>
          h.apiA.service.post(path, body),
        );
        expect(res.status, name).toBe(409);
        const row = await h.job(job.id);
        expect(row.status).toBe('claimed');
        expect(row.result).toBeNull();
        expect(row.last_error).toBeNull();
        expect(row.attempts).toBe(1);
        expect(new Date(row.locked_until).getTime()).toBeLessThan(Date.now());
        expect(await h.audit('workflow_job.complete', job.id)).toBe(0);
        expect(await h.audit('workflow_job.fail', job.id)).toBe(0);
        // El trabajo sigue recuperable: otro worker lo reclama y termina.
        const next = await h.claimOf(c.id, 'worker-next');
        expect(next.attempts).toBe(2);
        const done = await h.apiB.service.post(COMPLETE(job.id), {
          claimToken: next.claimToken,
          result: { from: 'vigente' },
        });
        expect(done.status).toBe(200);
      },
    );

    it.each(['propuesta', 'revisión', 'cierre del caso', 'fallo del caso'])(
      '%s retenida en el bloqueo del caso hasta el vencimiento: 409 sin escribir',
      async (kind) => {
        const user = await h.newUser();
        const { c, job } = await h.claimedCase(user);
        const claim = { jobId: job.id, claimToken: job.claimToken };
        const fire = () => {
          const base = `/internal/cases/${c.id}`;
          if (kind === 'propuesta') {
            return h.propose(c.id, job, { tarde: true });
          }
          if (kind === 'revisión') return h.review(c.id, job);
          if (kind === 'cierre del caso') {
            return h.apiA.service.post(`${base}/complete`, claim);
          }
          return h.apiA.service.post(`${base}/fail`, {
            ...claim,
            reason: 'tarde',
          });
        };
        const res = await whileLeaseExpires(
          job.id,
          { table: 'cases', id: c.id },
          fire,
        );
        expect(res.status).toBe(409);
        expect(
          await h.count(
            `SELECT count(*) AS n FROM case_proposals WHERE case_id = $1`,
            [c.id],
          ),
        ).toBe(0);
        expect(
          await h.count(
            `SELECT count(*) AS n FROM hitl_requests WHERE case_id = $1`,
            [c.id],
          ),
        ).toBe(0);
        const [row] = await h.sql(`SELECT status FROM cases WHERE id = $1`, [
          c.id,
        ]);
        expect(row!.status).toBe('processing');
      },
    );

    it('leer un documento retenido hasta el vencimiento: 409 sin registrar acceso', async () => {
      const user = await h.newUser();
      const { samplePdf } = await import('../support/sample-files.js');
      const up = await user.a.upload('/ingestions/documents', {
        name: 'f.pdf',
        type: 'application/pdf',
        bytes: samplePdf('lease'),
      });
      const job = await h.claimOf(up.body.caseId as string, 'w', {
        jobTypes: ['document.process'],
      });
      const res = await whileLeaseExpires(job.id, jobLock(job), () =>
        h.apiA.service.download(
          `/internal/documents/${up.body.documentId}/content`,
          { headers: { 'x-job-id': job.id, 'x-claim-token': job.claimToken } },
        ),
      );
      expect(res.status).toBe(409);
      expect(
        await h.audit('document.content_access', up.body.documentId as string),
      ).toBe(0);
    });
  });

  describe('Lo que no debe romperse', () => {
    it('complete retenido con el arrendamiento aún vigente se acepta', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const res = await whileBlocked(jobLock(job), () =>
        h.apiA.service.post(COMPLETE(job.id), {
          claimToken: job.claimToken,
          result: { ok: 1 },
        }),
      );
      expect(res.status).toBe(200);
      expect(await h.audit('workflow_job.complete', job.id)).toBe(1);
    });

    it('heartbeat retenido con el arrendamiento vigente renueva', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const res = await whileBlocked(jobLock(job), () =>
        h.apiA.service.post(HEARTBEAT(job.id), {
          claimToken: job.claimToken,
          leaseSeconds: 600,
        }),
      );
      expect(res.status).toBe(200);
      expect((await h.job(job.id)).status).toBe('claimed');
    });

    it('un reintento idéntico de un trabajo completado sigue siendo 200 aunque pase el tiempo', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const body = { claimToken: job.claimToken, result: { b: 2, a: 1 } };
      expect((await h.apiA.service.post(COMPLETE(job.id), body)).status).toBe(
        200,
      );
      const before = await h.job(job.id);
      // Mucho después de lo que duraba el arrendamiento original.
      await h.sql(
        `UPDATE workflow_jobs SET completed_at = completed_at - interval '2 days' WHERE id = $1`,
        [job.id],
      );
      const retry = await whileBlocked(jobLock(job), () =>
        h.apiB.service.post(COMPLETE(job.id), {
          claimToken: job.claimToken,
          result: { a: 1, b: 2 },
        }),
      );
      expect(retry.status).toBe(200);
      expect(await h.audit('workflow_job.complete', job.id)).toBe(1);
      expect((await h.job(job.id)).result).toEqual(before.result);
    });

    it('un resultado contradictorio tras el paso del tiempo sigue siendo 409', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      await h.apiA.service.post(COMPLETE(job.id), {
        claimToken: job.claimToken,
        result: { n: 1 },
      });
      const res = await whileBlocked(jobLock(job), () =>
        h.apiB.service.post(COMPLETE(job.id), {
          claimToken: job.claimToken,
          result: { n: 2 },
        }),
      );
      expect(res.status).toBe(409);
      expect((await h.job(job.id)).result).toEqual({ n: 1 });
    });

    it('un fail duplicado tras el paso del tiempo sigue siendo idempotente', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      const body = { claimToken: job.claimToken, error: 'x' };
      expect((await h.apiA.service.post(FAIL(job.id), body)).status).toBe(200);
      const retry = await whileBlocked(jobLock(job), () =>
        h.apiB.service.post(FAIL(job.id), body),
      );
      expect(retry.status).toBe(200);
      expect(await h.audit('workflow_job.fail', job.id)).toBe(1);
      expect((await h.job(job.id)).attempts).toBe(1);
    });

    it('un estado terminal prevalece sobre cualquier respuesta posterior', async () => {
      const user = await h.newUser();
      const { job } = await h.claimedCase(user);
      await h.apiA.service.post(FAIL(job.id), {
        claimToken: job.claimToken,
        error: 'definitivo',
        retryable: false,
      });
      const res = await h.apiA.service.post(COMPLETE(job.id), {
        claimToken: job.claimToken,
      });
      expect(res.status).toBe(409);
      expect((await h.job(job.id)).status).toBe('failed');
    });

    it('el worker antiguo sigue rechazado aunque compita con la nueva reclamación', async () => {
      const user = await h.newUser();
      const { c, job: old } = await h.claimedCase(user);
      await h.expireLease(old.id);
      const current = await h.claimOf(c.id, 'worker-new');
      const { results } = await h.behindLock(
        'fencing-after-clock-fix',
        { table: 'workflow_jobs', id: old.id },
        2,
        () => [
          h.apiA.service.post(COMPLETE(old.id), {
            claimToken: old.claimToken,
          }),
          h.apiB.service.post(COMPLETE(old.id), {
            claimToken: current.claimToken,
          }),
        ],
      );
      expect(results[0]!.status).toBe(409);
      expect(results[1]!.status).toBe(200);
    });
  });

  describe('Idempotencia de confirmaciones de períodos', () => {
    const setup = async () => {
      const user = await h.newUser();
      const obligation = await h.obligation(user);
      const occurrence = await h.occurrence(user, obligation);
      const path = `/obligations/${obligation}/occurrences/${occurrence}/confirm`;
      const row = async () =>
        (
          await h.sql(`SELECT * FROM obligation_occurrences WHERE id = $1`, [
            occurrence,
          ])
        )[0]!;
      return { user, occurrence, path, row };
    };

    it.each<[string, object, object, number]>([
      [
        'misma referencia',
        { result: 'paid', reference: 'R1' },
        { result: 'paid', reference: 'R1' },
        200,
      ],
      ['sin referencia', { result: 'paid' }, { result: 'paid' }, 200],
      [
        'referencia con espacios equivalentes',
        { result: 'paid', reference: 'R1' },
        { result: 'paid', reference: '  R1  ' },
        200,
      ],
      [
        'referencia distinta',
        { result: 'paid', reference: 'R1' },
        { result: 'paid', reference: 'R2' },
        409,
      ],
      [
        'añade referencia',
        { result: 'paid' },
        { result: 'paid', reference: 'R2' },
        409,
      ],
      [
        'omite la referencia registrada',
        { result: 'paid', reference: 'R1' },
        { result: 'paid' },
        409,
      ],
      [
        'otro tipo de confirmación',
        { result: 'paid', reference: 'R1' },
        { result: 'attended', reference: 'R1' },
        409,
      ],
    ])('repetición con %s', async (_n, first, second, expected) => {
      const { user, occurrence, path, row } = await setup();
      expect((await user.a.post(path, first)).status).toBe(200);
      const before = await row();
      const res = await user.b.post(path, second);
      expect(res.status).toBe(expected);
      expect(await row()).toEqual(before);
      expect(await h.audit('obligation_occurrence.confirm', occurrence)).toBe(
        1,
      );
    });

    it('referencias distintas a la vez: una gana, la otra 409 y nada se pisa', async () => {
      const { user, occurrence, path, row } = await setup();
      const { results } = await h.behindLock(
        'occurrence-different-reference',
        { table: 'obligation_occurrences', id: occurrence },
        2,
        () => [
          user.a.post(path, { result: 'paid', reference: 'A' }),
          user.b.post(path, { result: 'paid', reference: 'B' }),
        ],
      );
      expect(statuses(results)).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      expect((await row()).confirmation_reference).toBe(
        winner.body.confirmationReference,
      );
      expect(await h.audit('obligation_occurrence.confirm', occurrence)).toBe(
        1,
      );
    });

    it('otro propietario: 404, sin evento y sin alterar la confirmación', async () => {
      const { user, occurrence, path, row } = await setup();
      const bob = await h.newUser();
      await user.a.post(path, { result: 'paid', reference: 'R1' });
      const before = await row();
      const res = await bob.a.post(path, { result: 'paid', reference: 'R1' });
      expect(res.status).toBe(404);
      expect(await row()).toEqual(before);
      expect(before.confirmed_by).toBe(user.profileId);
      expect(await h.audit('obligation_occurrence.confirm', occurrence)).toBe(
        1,
      );
    });
  });
});
