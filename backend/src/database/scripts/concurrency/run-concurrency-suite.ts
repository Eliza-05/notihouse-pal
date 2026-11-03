/**
 * Suite de concurrencia real (Fase 4.2F.2). PREPARADA EN LA FASE 4.2F.1: NO
 * EJECUTADA. Procedimiento: docs/testing/neon-concurrency-plan.md.
 *
 * Lanza los escenarios contra una API en ejecución (con su pool de
 * conexiones) que apunta a una base DESCARTABLE. Los escenarios escriben
 * datos sintéticos y eventos de auditoría que NO se pueden borrar: por eso el
 * script se niega a ejecutarse salvo confirmación explícita del destino.
 *
 * Variables (ninguna contiene contraseñas):
 * - CONCURRENCY_API_URL         p. ej. http://127.0.0.1:3000/api/v1
 * - CONCURRENCY_DB_HOST          host esperado de DATABASE_URL_DIRECT (confirmación)
 * - CONCURRENCY_ACK              debe ser exactamente "writes-persist-on-disposable-branch"
 * - CONCURRENCY_CREDENTIALS_FILE ruta (fuera del repo) con "email<TAB>contraseña"
 * - CONCURRENCY_SCENARIOS        opcional: lista separada por comas
 * Además lee DATABASE_URL_DIRECT (backend/.env) para las verificaciones de
 * solo lectura (transacción READ ONLY).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { normalizeConnectionString } from '../../connection-string.js';
import { fail } from '../local-script-support.js';
import {
  type HttpActor,
  type HttpResult,
  runScenarios,
  SCENARIOS,
} from './scenarios.js';

export const REQUIRED_ACK = 'writes-persist-on-disposable-branch';

export function assertTargetConfirmed(
  env: NodeJS.ProcessEnv,
  dbHost: string,
): void {
  if (env.CONCURRENCY_ACK !== REQUIRED_ACK) {
    fail(`CONCURRENCY_ACK debe ser "${REQUIRED_ACK}"`);
  }
  if (!env.CONCURRENCY_DB_HOST || env.CONCURRENCY_DB_HOST !== dbHost) {
    fail(
      'CONCURRENCY_DB_HOST debe coincidir con el host de DATABASE_URL_DIRECT (confirma el destino)',
    );
  }
  if (env.RENDER || env.CI || env.NODE_ENV === 'production') {
    fail('La suite solo se ejecuta desde el equipo de un administrador');
  }
}

function actor(baseUrl: string, authorization: string): HttpActor {
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
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
  };
}

async function main(): Promise<void> {
  const connectionString = normalizeConnectionString(
    process.env.DATABASE_URL_DIRECT,
    'DATABASE_URL_DIRECT',
  );
  assertTargetConfirmed(process.env, new URL(connectionString).hostname);
  const baseUrl = process.env.CONCURRENCY_API_URL;
  const serviceToken = process.env.N8N_SERVICE_TOKEN;
  if (!baseUrl || !serviceToken) {
    fail('Faltan CONCURRENCY_API_URL o N8N_SERVICE_TOKEN');
  }
  const [email, password] = readFileSync(
    process.env.CONCURRENCY_CREDENTIALS_FILE ??
      fail('Falta CONCURRENCY_CREDENTIALS_FILE'),
    'utf8',
  )
    .trim()
    .split('\t');
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (login.status !== 200) fail(`Inicio de sesión: ${login.status}`);
  const { accessToken } = (await login.json()) as { accessToken: string };

  const verifier = new pg.Client({
    connectionString,
    application_name: 'notihouse-concurrency-verifier',
  });
  await verifier.connect();
  try {
    const runId = randomUUID().slice(0, 8);
    console.log(`Ejecución ${runId} (datos marcados con "CONC ${runId}")`);
    const results = await runScenarios(
      {
        runId,
        user: actor(baseUrl, `Bearer ${accessToken}`),
        service: actor(baseUrl, `Bearer ${serviceToken}`),
        readOnlyCount: async (query, params) => {
          await verifier.query('BEGIN READ ONLY');
          try {
            const { rows } = await verifier.query<{ n: string }>(query, params);
            return Number(rows[0]!.n);
          } finally {
            await verifier.query('ROLLBACK');
          }
        },
        waitForLeaseExpiry: (_jobId, seconds) =>
          new Promise((r) => setTimeout(r, (seconds + 2) * 1000)),
      },
      process.env.CONCURRENCY_SCENARIOS?.split(',') ?? Object.keys(SCENARIOS),
    );
    for (const r of results) {
      console.log(`${r.passed ? '✓' : '✗'} ${r.name}: ${r.details.join('; ')}`);
    }
    if (results.some((r) => !r.passed)) process.exitCode = 1;
  } finally {
    await verifier.end();
  }
}

if (process.argv[1]?.endsWith('run-concurrency-suite.js')) {
  try {
    await main();
  } catch (error) {
    console.error(`✗ Suite cancelada: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
