/**
 * Aplica las migraciones del repositorio ÚNICAMENTE al PostgreSQL QA local.
 * Uso: node --env-file=.local/qa/qa.env infra/qa/qa-migrate.mjs
 * Se niega a conectarse a cualquier host distinto de 127.0.0.1:55433.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, '..', '..', 'backend');
const require = createRequire(resolve(backend, 'package.json'));
const esm = (id) => import(pathToFileURL(require.resolve(id)).href);

const pw = process.env.QA_PG_PASSWORD;
if (!pw) throw new Error('Falta QA_PG_PASSWORD (usa --env-file=.local/qa/qa.env)');
const url = `postgresql://notihouse_qa_owner:${encodeURIComponent(pw)}@127.0.0.1:55433/notihouse_qa`;
const u = new URL(url);
if (u.hostname !== '127.0.0.1' || u.port !== '55433') throw new Error('Destino no permitido');

const pg = (await esm('pg')).default;
const { drizzle } = await esm('drizzle-orm/node-postgres');
const { migrate } = await esm('drizzle-orm/node-postgres/migrator');
const pool = new pg.Pool({ connectionString: url, max: 1 });
await migrate(drizzle({ client: pool }), {
  migrationsFolder: resolve(here, '..', '..', 'database', 'migrations'),
  migrationsSchema: 'drizzle',
  migrationsTable: '__drizzle_migrations',
});
const r = await pool.query('select count(*)::int n, current_database() db, version() v from drizzle.__drizzle_migrations');
console.log(`Migraciones aplicadas: ${r.rows[0].n} en ${r.rows[0].db} (${r.rows[0].v.split(' ').slice(0, 2).join(' ')})`);
await pool.end();
