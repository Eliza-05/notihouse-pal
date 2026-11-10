/**
 * Comprobación técnica de PostgreSQL (`npm run db:check`).
 *
 * Abre sesiones de solo lectura con DATABASE_URL (pooling, usada por la API) y
 * DATABASE_URL_DIRECT (usada por las migraciones), ejecuta `SELECT 1` y
 * resume el estado del esquema. Nunca imprime usuarios con contraseña ni
 * cadenas de conexión, y no modifica datos.
 */
import pg from 'pg';
import { normalizeConnectionString } from '../connection-string.js';

const VARIABLES = ['DATABASE_URL', 'DATABASE_URL_DIRECT'] as const;

function describeHost(connectionString: string) {
  const { hostname, pathname } = new URL(connectionString);
  return {
    database: pathname.slice(1),
    neon: hostname.endsWith('.neon.tech'),
    pooler: hostname.split('.')[0]?.endsWith('-pooler') ?? false,
    region: hostname.split('.').slice(1, -2).join('.'),
  };
}

async function check(variable: (typeof VARIABLES)[number]): Promise<boolean> {
  let connectionString: string;
  try {
    connectionString = normalizeConnectionString(
      process.env[variable],
      variable,
    );
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    return false;
  }

  const client = new pg.Client({
    connectionString,
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 15_000,
    application_name: 'notihouse-pal-db-check',
  });

  try {
    await client.connect();
    const ping = await client.query<{ ok: number }>('SELECT 1 AS ok');
    const info = await client.query<{
      database: string;
      role: string;
      version: string;
      tables: number;
      has_migrations_table: boolean;
    }>(`
      SELECT current_database() AS database,
             current_user AS role,
             current_setting('server_version') AS version,
             (SELECT count(*)::int FROM information_schema.tables
               WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
             to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS has_migrations_table
    `);
    const row = info.rows[0]!;
    const migrations = row.has_migrations_table
      ? (
          await client.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
          )
        ).rows[0]!.n
      : null;
    console.log(`✓ ${variable}`, {
      ...describeHost(connectionString),
      database: row.database,
      selectOne: ping.rows[0]?.ok === 1,
      role: row.role,
      serverVersion: row.version,
      publicTables: row.tables,
      appliedMigrations: migrations ?? 'tabla de migraciones inexistente',
    });
    return ping.rows[0]?.ok === 1;
  } catch (error) {
    // Los errores de `pg` no incluyen la contraseña, pero se muestra solo el mensaje.
    console.error(`✗ ${variable}: ${(error as Error).message}`);
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const results = await Promise.all(VARIABLES.map(check));
process.exitCode = results.every(Boolean) ? 0 : 1;
