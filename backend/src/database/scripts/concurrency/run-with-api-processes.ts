/**
 * Ejecuta los escenarios contra DOS procesos reales de la API (`dist/main.js`)
 * sobre el PostgreSQL descartable, con el rol restringido. Es la ejecución más
 * cercana a producción: procesos, pools y puertos independientes.
 *
 * Los procesos se lanzan con un entorno mínimo y explícito desde un directorio
 * sin `.env`: no pueden heredar DATABASE_URL, JWT_SECRET ni N8N_SERVICE_TOKEN
 * reales. Variables: CONCURRENCY_REPETITIONS (por defecto 5), CONCURRENCY_SCENARIOS.
 *
 * Uso: npm run conc:suite
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../../auth/password.js';
import { LOCAL_DIR } from '../local-script-support.js';
import { GUARD_STATE_FILE } from './init-disposable-db.js';
import {
  actor,
  connectGuardedOwner,
  roundRobin,
} from './run-concurrency-suite.js';
import { runScenarios, SCENARIOS } from './scenarios.js';
import { APP_ROLE, assertSafeConfiguration } from './target-guard.js';

const PORTS = [55801, 55802];
const MAIN = fileURLToPath(new URL('../../../main.js', import.meta.url));
const LEASE_REAL_WAIT_RUNS = 1;

async function waitHealthy(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.status === 200) return;
    } catch {
      // Todavía arrancando.
    }
    if (Date.now() > deadline) throw new Error(`API ${port} no respondió`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main(): Promise<void> {
  const env = process.env;
  assertSafeConfiguration(
    env,
    env.CONCURRENCY_TEST_DATABASE_URL,
    'CONCURRENCY_TEST_DATABASE_URL',
  );
  const state = JSON.parse(readFileSync(GUARD_STATE_FILE, 'utf8')) as {
    marker: string;
    systemIdentifier: string;
  };
  const owner = await connectGuardedOwner(
    env,
    state,
    'notihouse-concurrency-suite',
  );
  const verifier = await connectGuardedOwner(
    env,
    state,
    'notihouse-concurrency-verifier',
  );
  const scratch = mkdtempSync(join(tmpdir(), 'notihouse-conc-api-'));
  const children: ChildProcess[] = [];
  const serviceToken = env.CONCURRENCY_TEST_SERVICE_TOKEN!;
  try {
    // Cuenta sintética propia de esta ejecución; nunca una cuenta demo.
    const email = `suite-${randomUUID().slice(0, 8)}@concurrency.test`;
    const password = randomBytes(16).toString('base64url');
    const profile = await owner.query<{ id: string }>(
      `INSERT INTO profiles (display_name) VALUES ('Suite sintética') RETURNING id`,
    );
    await owner.query(
      `INSERT INTO auth_accounts (profile_id, email, password_hash) VALUES ($1, $2, $3)`,
      [profile.rows[0]!.id, email, await hashPassword(password)],
    );

    for (const port of PORTS) {
      const child = spawn(process.execPath, [MAIN], {
        cwd: scratch,
        stdio: 'ignore',
        env: {
          PATH: env.PATH,
          SystemRoot: env.SystemRoot,
          NODE_ENV: 'development',
          PORT: String(port),
          FRONTEND_URL: 'http://localhost:5173',
          DATABASE_URL: env.CONCURRENCY_TEST_DATABASE_URL,
          JWT_SECRET: env.CONCURRENCY_TEST_JWT_SECRET,
          N8N_SERVICE_TOKEN: serviceToken,
          STORAGE_DRIVER: 'local',
          STORAGE_LOCAL_PATH: join(scratch, 'storage'),
          STORAGE_UPLOAD_TMP_PATH: join(scratch, 'uploads'),
        },
      });
      children.push(child);
    }
    await Promise.all(PORTS.map(waitHealthy));

    const bases = PORTS.map((p) => `http://127.0.0.1:${p}/api/v1`);
    const tokens: string[] = [];
    for (const base of bases) {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.status !== 200) throw new Error(`Login: ${res.status}`);
      tokens.push(((await res.json()) as { accessToken: string }).accessToken);
    }
    const user = roundRobin(
      bases.map((base, i) => actor(base, `Bearer ${tokens[i]}`)),
    );
    const service = roundRobin(
      bases.map((base) => actor(base, `Bearer ${serviceToken}`)),
    );

    const roles = await owner.query<{ usename: string }>(
      `SELECT DISTINCT usename FROM pg_stat_activity WHERE application_name = 'notihouse-pal-api'`,
    );
    if (roles.rows.length !== 1 || roles.rows[0]!.usename !== APP_ROLE) {
      throw new Error('La API no se conectó con el rol restringido');
    }

    const names =
      env.CONCURRENCY_SCENARIOS?.split(',') ?? Object.keys(SCENARIOS);
    const repetitions = Number(env.CONCURRENCY_REPETITIONS ?? 5);
    const report: unknown[] = [];
    let failed = false;
    for (let run = 0; run < repetitions; run++) {
      await owner.query(
        `UPDATE workflow_jobs SET status = 'cancelled', locked_until = NULL
          WHERE status IN ('pending', 'claimed')`,
      );
      const runId = randomUUID().slice(0, 8);
      const results = await runScenarios(
        {
          runId,
          user,
          service,
          readOnlyCount: async (query, params) => {
            await verifier.query('BEGIN READ ONLY');
            try {
              const { rows } = await verifier.query<{ n: string }>(
                query,
                params,
              );
              return Number(rows[0]!.n);
            } finally {
              await verifier.query('ROLLBACK');
            }
          },
          // La primera repetición espera el vencimiento real; el resto lo
          // simula sobre esta base descartable para no alargar la ejecución.
          waitForLeaseExpiry: async (jobId, seconds) => {
            if (run < LEASE_REAL_WAIT_RUNS) {
              await new Promise((r) => setTimeout(r, (seconds + 2) * 1000));
            } else {
              await owner.query(
                `UPDATE workflow_jobs SET locked_until = now() - interval '1 second' WHERE id = $1`,
                [jobId],
              );
            }
          },
        },
        names,
      );
      for (const r of results) {
        console.log(
          `[${run + 1}/${repetitions}] ${r.passed ? '✓' : '✗'} ${r.name}: ${r.details.join('; ')}`,
        );
      }
      report.push({ run: run + 1, runId, results });
      if (results.some((r) => !r.passed)) {
        failed = true;
        break; // Criterio de parada: no se reintenta sin analizar.
      }
    }
    const violations = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT occurrence_id FROM alerts WHERE state = 'active' AND occurrence_id IS NOT NULL
          GROUP BY occurrence_id HAVING count(*) > 1) s`,
    );
    mkdirSync(`${LOCAL_DIR}concurrency`, { recursive: true });
    writeFileSync(
      `${LOCAL_DIR}concurrency/suite-report.json`,
      JSON.stringify(
        {
          apis: PORTS.length,
          report,
          duplicateActiveAlerts: violations.rows[0]!.n,
        },
        null,
        2,
      ),
    );
    console.log(`Alertas activas duplicadas: ${violations.rows[0]!.n}`);
    if (failed || violations.rows[0]!.n !== '0') process.exitCode = 1;
  } finally {
    for (const child of children) child.kill();
    await Promise.all(
      children.map(
        (child) =>
          new Promise((r) =>
            child.exitCode === null ? child.once('exit', r) : r(null),
          ),
      ),
    );
    await owner.end();
    await verifier.end();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('run-with-api-processes.js')) {
  try {
    await main();
  } catch (error) {
    console.error(`✗ Suite cancelada: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
