import { randomUUID } from 'node:crypto';
import type { Test } from 'supertest';
import {
  assertSafeConfiguration,
  ENABLE_VALUE,
  UnsafeTargetError,
} from '../src/database/scripts/concurrency/target-guard.js';
import {
  type HttpActor,
  runScenarios,
  SCENARIOS,
} from '../src/database/scripts/concurrency/scenarios.js';
import {
  createProcessWorld,
  processHelpers,
  type ProcessWorld,
} from './support/process-fixtures.js';
import type { AuthedClient } from './support/test-app.js';

/**
 * Valida la LÓGICA de la suite de concurrencia de la Fase 4.2F.2 contra la
 * API en proceso sobre PGlite. PGlite tiene una sola conexión: esta prueba no
 * demuestra contención entre conexiones; eso solo lo hace la ejecución real
 * descrita en docs/testing/neon-concurrency-plan.md.
 */
describe('Concurrency suite scenarios (logic on PGlite)', () => {
  let w: ProcessWorld;
  const { sql, drainQueue, expireLease } = processHelpers(() => w);

  const adapt = (client: AuthedClient): HttpActor => {
    const run = async (test: Test) => {
      const res = await test;
      return { status: res.status, body: res.body };
    };
    return {
      get: (path) => run(client.get(path)),
      post: (path, body) => run(client.post(path, body ?? {})),
    };
  };

  beforeAll(async () => {
    w = await createProcessWorld();
    await drainQueue();
  }, 60_000);

  afterAll(async () => {
    await w.h.app.close();
  });

  it('passes every scenario', async () => {
    const results = await runScenarios({
      runId: randomUUID().slice(0, 8),
      user: adapt(w.h.as(w.laura)),
      service: adapt(w.h.asService()),
      readOnlyCount: async (query, params) =>
        Number((await sql<{ n: string }>(query, params))[0]!.n),
      waitForLeaseExpiry: async (jobId) => {
        await expireLease(jobId);
      },
    });
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(Object.keys(SCENARIOS));
  });

  it('refuses any target other than the disposable local PostgreSQL', () => {
    const neon = 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb';
    const local = 'postgresql://u:p@127.0.0.1:55432/notihouse_concurrency';
    const enabled = { CONCURRENCY_TEST_ENABLED: ENABLE_VALUE };
    expect(() => assertSafeConfiguration({}, local, 'X')).toThrow(
      UnsafeTargetError,
    );
    expect(() => assertSafeConfiguration(enabled, neon, 'X')).toThrow(
      UnsafeTargetError,
    );
    expect(() =>
      assertSafeConfiguration({ ...enabled, RENDER: 'true' }, local, 'X'),
    ).toThrow(UnsafeTargetError);
    expect(() => assertSafeConfiguration(enabled, local, 'X')).not.toThrow();
  });
});
