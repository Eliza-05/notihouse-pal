import { randomUUID } from 'node:crypto';
import type { Test } from 'supertest';
import {
  assertTargetConfirmed,
  REQUIRED_ACK,
} from '../src/database/scripts/concurrency/run-concurrency-suite.js';
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

  it('refuses to run without an explicit, matching target', () => {
    const host = 'ep-example.us-east-2.aws.neon.tech';
    expect(() => assertTargetConfirmed({}, host)).toThrow(/CONCURRENCY_ACK/);
    expect(() =>
      assertTargetConfirmed(
        { CONCURRENCY_ACK: REQUIRED_ACK, CONCURRENCY_DB_HOST: 'other' },
        host,
      ),
    ).toThrow(/CONCURRENCY_DB_HOST/);
    expect(() =>
      assertTargetConfirmed(
        {
          CONCURRENCY_ACK: REQUIRED_ACK,
          CONCURRENCY_DB_HOST: host,
          RENDER: 'true',
        },
        host,
      ),
    ).toThrow(/administrador/);
    expect(() =>
      assertTargetConfirmed(
        { CONCURRENCY_ACK: REQUIRED_ACK, CONCURRENCY_DB_HOST: host },
        host,
      ),
    ).not.toThrow();
  });
});
