import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calendarDateIn } from '../../src/due-dates/calendar.js';
import { samplePdf } from '../support/sample-files.js';
import { type ClaimedJob, Harness, type Res } from './support/harness.js';

const OUT = fileURLToPath(
  new URL('../../.local/concurrency/load-metrics.json', import.meta.url),
);

interface Metric {
  scenario: string;
  requests: number;
  statuses: Record<string, number>;
  unexpected: number;
  p50ms: number;
  maxMs: number;
  peakSessions: number;
  peakLockWaits: number;
  duplicates: number;
}

/**
 * Estrés moderado y acotado para descubrir carreras que no aparecen con dos
 * solicitudes. Los tiempos son orientativos de esta máquina y de Docker local:
 * NO son una garantía de rendimiento en Render ni en Neon.
 */
describe('Carga controlada en PostgreSQL real', () => {
  let h: Harness;
  const metrics: Metric[] = [];

  beforeAll(async () => {
    h = await Harness.start();
    await h.retireOpenWork();
  });
  afterAll(async () => {
    mkdirSync(
      fileURLToPath(new URL('.', `file:///${OUT.replaceAll('\\', '/')}`)),
      {
        recursive: true,
      },
    );
    writeFileSync(OUT, JSON.stringify(metrics, null, 2));
    await h.close();
  });
  beforeEach(() => h.drainQueue());

  /** Lanza todo a la vez, midiendo tiempos y muestreando pg_stat_activity. */
  const storm = async (
    scenario: string,
    expected: number[],
    fire: (() => Promise<Res>)[],
  ) => {
    let peakSessions = 0;
    let peakLockWaits = 0;
    let done = false;
    const sampler = (async () => {
      while (!done) {
        const [row] = await h.sql<{ active: string; waiting: string }>(
          `SELECT count(*) FILTER (WHERE state <> 'idle') AS active,
                  count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting
             FROM pg_stat_activity WHERE application_name LIKE 'notihouse-pal-api%'`,
        );
        peakSessions = Math.max(peakSessions, Number(row!.active));
        peakLockWaits = Math.max(peakLockWaits, Number(row!.waiting));
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    const durations: number[] = [];
    const results = await Promise.all(
      fire.map(async (call) => {
        const started = performance.now();
        const res = await call();
        durations.push(performance.now() - started);
        return res;
      }),
    );
    done = true;
    await sampler;
    durations.sort((a, b) => a - b);
    const histogram: Record<string, number> = {};
    for (const r of results)
      histogram[r.status] = (histogram[r.status] ?? 0) + 1;
    const metric: Metric = {
      scenario,
      requests: results.length,
      statuses: histogram,
      unexpected: results.filter((r) => !expected.includes(r.status)).length,
      p50ms: Math.round(durations[Math.floor(durations.length / 2)]!),
      maxMs: Math.round(durations[durations.length - 1]!),
      peakSessions,
      peakLockWaits,
      duplicates: 0,
    };
    metrics.push(metric);
    return { results, metric };
  };

  it('10 workers × 5 rondas reclaman 40 trabajos sin duplicar', async () => {
    const user = await h.newUser();
    await Promise.all(
      Array.from({ length: 40 }, () =>
        user.a.post('/cases', { type: 'household_obligation' }),
      ),
    );
    const claimed: ClaimedJob[] = [];
    for (let round = 0; round < 5; round++) {
      const { results, metric } = await storm(
        `claim-10-workers-r${round}`,
        [200],
        Array.from(
          { length: 10 },
          (_, i) => () =>
            h.claim(`load-${i}`, { limit: 4 }, i % 2 ? h.apiA : h.apiB),
        ),
      );
      expect(metric.unexpected).toBe(0);
      claimed.push(...results.flatMap((r) => r.body.jobs as ClaimedJob[]));
    }
    const distinct = new Set(claimed.map((j) => j.id)).size;
    metrics[metrics.length - 1]!.duplicates = claimed.length - distinct;
    expect(distinct).toBe(claimed.length);
    expect(distinct).toBe(40);
    expect(claimed.every((j) => j.attempts === 1)).toBe(true);
  });

  it('20 solicitudes con la misma clave de idempotencia', async () => {
    const user = await h.newUser();
    const requestId = crypto.randomUUID();
    const { results, metric } = await storm(
      'case-idempotency-20',
      [200, 201],
      Array.from(
        { length: 20 },
        (_, i) => () =>
          (i % 2 ? user.a : user.b).post('/cases', {
            type: 'household_obligation',
            requestId,
          }),
      ),
    );
    expect(metric.unexpected).toBe(0);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      await h.count(`SELECT count(*) AS n FROM cases WHERE owner_id = $1`, [
        user.profileId,
      ]),
    ).toBe(1);
  });

  it('20 evaluaciones de alertas concurrentes', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const today = calendarDateIn(new Date(), 'America/Bogota');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        await h.occurrence(
          user,
          obligation,
          today,
          `2023-${String(i + 1).padStart(2, '0')}-01`,
        ),
      );
    }
    const { metric } = await storm(
      'alert-evaluation-20',
      [200],
      Array.from(
        { length: 20 },
        (_, i) => () =>
          (i % 2 ? h.apiA : h.apiB).service.post('/internal/alerts/evaluate', {
            workerId: `load-${i}`,
            batchSize: 25,
          }),
      ),
    );
    expect(metric.unexpected).toBe(0);
    const [row] = await h.sql(
      `SELECT count(*)::int AS total, count(DISTINCT occurrence_id)::int AS distinct_resources
         FROM alerts WHERE occurrence_id = ANY($1::uuid[]) AND state = 'active'`,
      [ids],
    );
    expect(row).toEqual({ total: 10, distinct_resources: 10 });
  });

  it('10 aplicaciones simultáneas de una propuesta', async () => {
    const user = await h.newUser();
    const r = await h.approvedProposal(user);
    const { results, metric } = await storm(
      'apply-10',
      [200, 201],
      Array.from(
        { length: 10 },
        (_, i) => () =>
          (i % 2 ? user.a : user.b).post(
            `/cases/${r.caseId}/proposals/${r.proposalId}/apply`,
          ),
      ),
    );
    expect(metric.unexpected).toBe(0);
    expect(results.filter((x) => x.status === 201)).toHaveLength(1);
    expect(
      await h.count(
        `SELECT count(*) AS n FROM obligation_occurrences WHERE obligation_id = $1`,
        [r.obligationId],
      ),
    ).toBe(1);
  });

  it('10 confirmaciones idénticas de un cobro y de un período', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const occurrence = await h.occurrence(user, obligation);
    const rental = await h.rental(user);
    const charge = await h.charge(user, rental);
    const first = await storm(
      'confirm-occurrence-10',
      [200],
      Array.from(
        { length: 10 },
        (_, i) => () =>
          (i % 2 ? user.a : user.b).post(
            `/obligations/${obligation}/occurrences/${occurrence}/confirm`,
            { result: 'paid' },
          ),
      ),
    );
    const second = await storm(
      'confirm-charge-10',
      [200],
      Array.from(
        { length: 10 },
        (_, i) => () =>
          (i % 2 ? user.a : user.b).post(
            `/rentals/${rental}/charges/${charge}/confirm`,
            { evidence: 'Carga controlada' },
          ),
      ),
    );
    expect(first.metric.unexpected + second.metric.unexpected).toBe(0);
    expect(await h.audit('obligation_occurrence.confirm', occurrence)).toBe(1);
    expect(await h.audit('rent_charge.confirm', charge)).toBe(1);
  });

  it('subidas de varios usuarios respetando los límites de concurrencia', async () => {
    const users = await Promise.all(
      Array.from({ length: 5 }, (_, i) => h.newUser(`up${i}`)),
    );
    const { results, metric } = await storm(
      'uploads-5-users',
      [201],
      users.flatMap((user, i) =>
        [0, 1].map(
          (n) => () =>
            user.a.upload('/ingestions/documents', {
              name: 'f.pdf',
              type: 'application/pdf',
              bytes: samplePdf(`carga ${i}-${n}`),
            }),
        ),
      ),
    );
    expect(metric.unexpected).toBe(0);
    expect(new Set(results.map((r) => r.body.caseId)).size).toBe(10);
    await expect
      .poll(() =>
        h.count(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE application_name LIKE 'notihouse-pal-api%' AND state LIKE 'idle in transaction%'`,
        ),
      )
      .toBe(0);
  });
});
