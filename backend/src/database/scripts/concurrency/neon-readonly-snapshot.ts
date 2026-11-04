/**
 * Huella de SOLO LECTURA de la base configurada en DATABASE_URL_DIRECT (Neon).
 *
 * Sirve para demostrar que una fase de pruebas no alteró la base real: se
 * ejecuta antes y después y se comparan los archivos. Nunca imprime datos:
 * solo conteos y resúmenes md5 por tabla. La sesión se abre con
 * `default_transaction_read_only=on` y la consulta va dentro de
 * `BEGIN READ ONLY`, de modo que PostgreSQL rechazaría cualquier escritura.
 *
 * Uso: node --env-file=.env dist/database/scripts/concurrency/neon-readonly-snapshot.js
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { normalizeConnectionString } from '../../connection-string.js';

const client = new pg.Client({
  connectionString: normalizeConnectionString(
    process.env.DATABASE_URL_DIRECT,
    'DATABASE_URL_DIRECT',
  ),
  options: '-c default_transaction_read_only=on',
  connectionTimeoutMillis: 20_000,
  application_name: 'notihouse-readonly-snapshot',
});

async function main(): Promise<void> {
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const perTable: Record<string, { rows: number; md5: string | null }> = {};
    for (const { name } of tables) {
      // `name` procede del catálogo; se cita como identificador.
      const quoted = client.escapeIdentifier(name);
      const { rows } = await client.query<{ n: string; md5: string | null }>(
        `SELECT count(*) AS n,
                md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)) AS md5
           FROM ${quoted} t`,
      );
      perTable[name] = { rows: Number(rows[0]!.n), md5: rows[0]!.md5 };
    }
    const { rows: migrations } = await client.query<{
      hash: string;
      created_at: string;
    }>(
      `SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    const { rows: triggers } = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'audit_events' AND NOT t.tgisinternal ORDER BY tgname`,
    );
    // Solo un conteo: compatibilidad de la política de arriendos con los datos.
    const { rows: overlaps } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM rentals x JOIN rentals y
          ON x.property_id = y.property_id AND x.id < y.id
       WHERE x.status IN ('active', 'suspended') AND y.status IN ('active', 'suspended')
         AND daterange(x.starts_on, x.ends_on, '[]') && daterange(y.starts_on, y.ends_on, '[]')`,
    );
    await client.query('ROLLBACK');
    console.error(`Arriendos solapados: ${overlaps[0]!.n}`);
    const snapshot = {
      publicTables: tables.length,
      appliedMigrations: migrations.map((m) => m.hash),
      auditTriggers: triggers.map((t) => t.tgname),
      perTable,
    };
    console.log(
      JSON.stringify(
        {
          ...snapshot,
          overallSha256: createHash('sha256')
            .update(JSON.stringify(snapshot))
            .digest('hex'),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`✗ Huella cancelada: ${(error as Error).message}`);
  process.exitCode = 1;
}
