/**
 * Utilidades de los escenarios QA (solo entorno local aislado). Nunca imprimen secretos.
 * Uso: node --env-file=.local/qa/qa.env infra/qa/scenarios/<x>.mjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..');
const require = createRequire(resolve(ROOT, 'backend', 'package.json'));
const pg = (await import(pathToFileURL(require.resolve('pg')).href)).default;

export const API = `http://localhost:${process.env.QA_BACKEND_PORT ?? 3100}/api/v1`;
if (!/^http:\/\/localhost:\d+\/api\/v1$/.test(API)) throw new Error('API no local');
export const MOCK = 'http://127.0.0.1:3200';

export async function http(method, path, { token, body, service, form, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (service) h.authorization = `Bearer ${process.env.QA_N8N_SERVICE_TOKEN}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + path, { method, headers: h, body: payload });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

export async function login(who = 'DANIEL') {
  const r = await http('POST', '/auth/login', { body: { email: process.env[`QA_USER_EMAIL_${who}`], password: process.env[`QA_USER_PASSWORD_${who}`] } });
  if (r.status !== 200) throw new Error(`login ${who} -> ${r.status}`);
  return r.body.accessToken ?? r.body.access_token ?? r.body.token;
}

const pool = new pg.Pool({ connectionString: `postgresql://notihouse_qa_owner:${encodeURIComponent(process.env.QA_PG_PASSWORD)}@127.0.0.1:55433/notihouse_qa`, max: 2 });
export const sql = async (q, p = []) => (await pool.query(q, p)).rows;
export const close = () => pool.end();

/** Ejecuta un workflow por id en el n8n QA (ejecución manual desde la CLI). */
export function n8nRun(id) {
  const r = spawnSync('docker', ['exec', '-e', 'N8N_RUNNERS_BROKER_PORT=5690', 'notihouse-qa-n8n', 'n8n', 'execute', '--id', id], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { status: r.status, out };
}
export const mock = async (path, body) => (await fetch(MOCK + path, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
