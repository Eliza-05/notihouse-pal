/**
 * Reinicia la BASE QA LOCAL (127.0.0.1:55433/notihouse_qa): elimina los esquemas, aplica las
 * migraciones del repositorio, ejecuta el seed oficial y guarda las contraseñas nuevas en
 * .local/qa/qa.env (ignorado por Git). Se niega a tocar cualquier otro destino.
 * Uso: node --env-file=.local/qa/qa.env infra/qa/reset-qa.mjs
 * Después hay que reiniciar el backend QA (cierra su pool) y borrar tokens cacheados (lo hace este script).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const require = createRequire(resolve(ROOT, 'backend', 'package.json'));
const pg = (await import(pathToFileURL(require.resolve('pg')).href)).default;
const pw = process.env.QA_PG_PASSWORD;
if (!pw) throw new Error('Falta QA_PG_PASSWORD');
const url = `postgresql://notihouse_qa_owner:${encodeURIComponent(pw)}@127.0.0.1:55433/notihouse_qa`;
const u = new URL(url);
if (u.hostname !== '127.0.0.1' || u.port !== '55433' || u.pathname !== '/notihouse_qa') throw new Error('Destino no permitido');

const pool = new pg.Pool({ connectionString: url, max: 1 });
await pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
await pool.end();
const mig = spawnSync(process.execPath, ['--env-file=.local/qa/qa.env', resolve(here, 'qa-migrate.mjs')], { cwd: ROOT, encoding: 'utf8' });
if (mig.status !== 0) throw new Error('migración falló: ' + (mig.stderr || mig.stdout).slice(0, 300));
console.log(mig.stdout.trim());

const local = resolve(ROOT, 'backend', '.local');
const before = new Set(existsSync(local) ? readdirSync(local) : []);
const seed = spawnSync(process.execPath, [resolve(ROOT, 'backend', 'dist', 'database', 'scripts', 'seed-demo.js')], {
  cwd: resolve(ROOT, 'backend'), encoding: 'utf8',
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', DATABASE_URL_DIRECT: url },
});
if (seed.status !== 0) throw new Error('seed falló: ' + (seed.stderr || seed.stdout).slice(0, 300));
const created = readdirSync(local).filter((f) => !before.has(f) && /^demo-credentials-.*\.txt$/.test(f));
if (created.length !== 1) throw new Error('No se encontró el archivo de credenciales del seed');
const file = resolve(local, created[0]);
const m = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const [, email, pass] = l.split('\t'); return [email, pass]; }));
const envFile = resolve(ROOT, '.local', 'qa', 'qa.env');
const keep = readFileSync(envFile, 'utf8').split('\n').filter((l) => l && !/^QA_USER_(EMAIL|PASSWORD)/.test(l));
keep.push(
  'QA_USER_EMAIL_DANIEL=daniel.rojas@notihouse.com', `QA_USER_PASSWORD_DANIEL=${m['daniel.rojas@notihouse.com']}`,
  'QA_USER_EMAIL_OTHER=laura.martinez@notihouse.com', `QA_USER_PASSWORD_OTHER=${m['laura.martinez@notihouse.com']}`,
  'QA_USER_EMAIL_ANDRES=andres.gomez@notihouse.com', `QA_USER_PASSWORD_ANDRES=${m['andres.gomez@notihouse.com']}`,
);
writeFileSync(envFile, keep.join('\n') + '\n', { mode: 0o600 });
unlinkSync(file);
const tokens = resolve(ROOT, '.local', 'qa', 'tokens.json');
if (existsSync(tokens)) unlinkSync(tokens);
console.log('Base QA reiniciada: migraciones + seed oficial; credenciales regeneradas (no mostradas).');
