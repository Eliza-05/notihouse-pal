/**
 * Cliente HTTP y conexión de verificación de la suite de escenarios.
 *
 * Fase 4.2F.2: la ejecución contra bases que no sean el PostgreSQL descartable
 * se eliminó (antes se admitía una confirmación manual del host, que no impedía
 * apuntar a Neon). Toda escritura pasa ahora por target-guard.ts. El punto de
 * entrada es run-with-api-processes.ts.
 */
import pg from 'pg';
import type { HttpActor, HttpResult } from './scenarios.js';
import {
  assertConnectedTarget,
  assertSafeConfiguration,
  type GuardState,
  OWNER_ROLE,
} from './target-guard.js';

export function actor(baseUrl: string, authorization: string): HttpActor {
  const call = async (
    method: string,
    path: string,
    body?: object,
  ): Promise<HttpResult> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
  };
}

/** Reparte cada solicitud entre las instancias: pools y sesiones distintos. */
export function roundRobin(actors: HttpActor[]): HttpActor {
  let next = 0;
  const pick = () => actors[next++ % actors.length]!;
  return {
    get: (path) => pick().get(path),
    post: (path, body) => pick().post(path, body),
  };
}

/** Conexión de propietario local, ya verificada contra la barrera. */
export async function connectGuardedOwner(
  env: NodeJS.ProcessEnv,
  state: GuardState,
  applicationName: string,
): Promise<pg.Client> {
  const url = env.CONCURRENCY_TEST_DATABASE_URL_DIRECT;
  assertSafeConfiguration(env, url, 'CONCURRENCY_TEST_DATABASE_URL_DIRECT');
  const client = new pg.Client({
    connectionString: url,
    application_name: applicationName,
  });
  await client.connect();
  try {
    await assertConnectedTarget(client, OWNER_ROLE, state);
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}
