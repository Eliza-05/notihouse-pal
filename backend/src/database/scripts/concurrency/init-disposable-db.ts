/**
 * Inicializa el PostgreSQL descartable: valida el destino, aplica las
 * migraciones versionadas con el rol propietario, crea el rol restringido con
 * los SQL de database/admin/ y deja la marca de inicialización.
 *
 * Reproducible: si la base ya está marcada, solo verifica. Nunca usa
 * DATABASE_URL ni DATABASE_URL_DIRECT, y no copia nada de Neon.
 *
 * Uso: npm run conc:init (requiere backend/.local/concurrency.env)
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LOCAL_DIR } from '../local-script-support.js';
import {
  APP_ROLE,
  assertConnectedTarget,
  assertSafeConfiguration,
  EXPECTED_DATABASE,
  type GuardState,
  MARKER_PREFIX,
  OWNER_ROLE,
} from './target-guard.js';

export const GUARD_STATE_FILE = `${LOCAL_DIR}concurrency/guard-state.json`;
const REPO_DATABASE = fileURLToPath(
  new URL('../../../../../database/', import.meta.url),
);

async function main(): Promise<void> {
  const url = process.env.CONCURRENCY_TEST_DATABASE_URL_DIRECT;
  assertSafeConfiguration(
    process.env,
    url,
    'CONCURRENCY_TEST_DATABASE_URL_DIRECT',
  );
  const marker = process.env.CONCURRENCY_TEST_MARKER;
  const appPassword = process.env.CONCURRENCY_APP_PASSWORD;
  if (!marker || !appPassword) {
    throw new Error('Faltan variables locales: ejecuta npm run conc:env');
  }

  const client = new pg.Client({
    connectionString: url,
    application_name: 'notihouse-concurrency-init',
  });
  await client.connect();
  try {
    const facts = await assertConnectedTarget(client, OWNER_ROLE, null);
    const expectedComment = `${MARKER_PREFIX}${marker}`;
    if (facts.comment !== null && facts.comment !== expectedComment) {
      throw new Error('La base tiene una marca de otro entorno; no se toca');
    }
    if (facts.comment === null) {
      // Sin marca solo se admite una base recién creada: nada en `public`.
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      if (Number(rows[0]!.n) !== 0) {
        throw new Error('La base sin marca ya contiene tablas; no se toca');
      }
    }

    await migrate(drizzle({ client }), {
      migrationsFolder: `${REPO_DATABASE}migrations`,
      migrationsSchema: 'drizzle',
      migrationsTable: '__drizzle_migrations',
    });

    for (const file of [
      '01-create-app-role.sql',
      '02-grant-app-privileges.sql',
    ]) {
      await client.query(readFileSync(`${REPO_DATABASE}admin/${file}`, 'utf8'));
    }
    // Solo aquí se habilita LOGIN: es un rol local con contraseña aleatoria.
    await client.query(
      `ALTER ROLE ${APP_ROLE} LOGIN PASSWORD ${client.escapeLiteral(appPassword)}`,
    );
    await client.query(
      `COMMENT ON DATABASE ${EXPECTED_DATABASE} IS ${client.escapeLiteral(expectedComment)}`,
    );

    const state: GuardState = {
      marker,
      systemIdentifier: facts.systemIdentifier,
    };
    writeFileSync(GUARD_STATE_FILE, JSON.stringify(state), { mode: 0o600 });

    const { rows } = await client.query<{ tables: string; migrations: string }>(
      `SELECT (SELECT count(*) FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
              (SELECT count(*) FROM drizzle.__drizzle_migrations) AS migrations`,
    );
    const { rows: version } = await client.query<{ v: string }>(
      `SELECT current_setting('server_version') AS v`,
    );
    console.log(
      `✓ PostgreSQL ${version[0]!.v} listo: ${rows[0]!.tables} tablas, ${rows[0]!.migrations} migraciones`,
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('init-disposable-db.js')) {
  try {
    await main();
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
