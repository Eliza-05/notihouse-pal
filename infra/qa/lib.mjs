/**
 * Utilidades de los escenarios QA (solo entorno local aislado). Nunca imprimen secretos.
 * Uso: node --env-file=.local/qa/qa.env infra/qa/scenarios/<x>.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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

const TOKEN_CACHE = resolve(ROOT, '.local', 'qa', 'tokens.json');
/** Inicia sesión (JWT de 2 h, cacheado 20 min en .local/ para respetar el límite de 5 logins/min). */
export async function login(who = 'DANIEL', { fresh = false } = {}) {
  let cache = {}; try { cache = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')); } catch { /* sin caché */ }
  if (!fresh && cache[who] && Date.now() - cache[who].at < 20 * 60 * 1000) return cache[who].token;
  const r = await http('POST', '/auth/login', { body: { email: process.env[`QA_USER_EMAIL_${who}`], password: process.env[`QA_USER_PASSWORD_${who}`] } });
  if (r.status !== 200) throw new Error(`login ${who} -> ${r.status}`);
  cache[who] = { token: r.body.accessToken, at: Date.now() };
  writeFileSync(TOKEN_CACHE, JSON.stringify(cache), { mode: 0o600 });
  return cache[who].token;
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
// `connection: close`: tras una ejecución larga de n8n el servidor simulado ya cerró el socket inactivo (5 s) y reutilizarlo daba ECONNRESET.
export const mock = async (path, body) => (await fetch(MOCK + path, { headers: { connection: 'close' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })).json();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };

/** Opera el kill switch con el script oficial, solo sobre la base QA local. */
export function killSwitch(...args) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', CONFIRM_KILL_SWITCH: 'notihouse_qa',
    DATABASE_URL_DIRECT: `postgresql://notihouse_qa_owner:${encodeURIComponent(process.env.QA_PG_PASSWORD)}@127.0.0.1:55433/notihouse_qa` };
  const r = spawnSync(process.execPath, [resolve(ROOT, 'backend', 'dist', 'database', 'scripts', 'kill-switch.js'), ...args], { encoding: 'utf8', env });
  return { status: r.status, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}
/** Estado final de la ejecución más reciente del workflow en n8n QA. */
export function lastExecution(out) {
  const status = /"status": "(\w+)",\s*"finished"/.exec(out)?.[1] ?? 'desconocido';
  const err = /"message": "([^"]{0,300})"/.exec(out)?.[1] ?? null;
  return { status, err };
}

export const WF04 = 'nhpVoiceProc0001';
export const WF03 = 'nhpHitlClose0001';
/** Envía un mensaje de texto como el usuario y lo procesa con el workflow 04 real de n8n QA. */
export async function textThroughN8n(token, text, extra = {}) {
  const r = await http('POST', '/ingestions/text', { token, body: { text, ...extra } });
  if (r.status !== 201) throw new Error(`ingesta texto -> ${r.status}`);
  const caseId = r.body.caseId;
  let run = n8nRun(WF04);
  // n8n procesa un trabajo por ejecución (el más antiguo): repetir hasta procesar este caso.
  for (let i = 0; i < 12; i += 1) {
    const st = (await sql("select status from workflow_jobs where case_id=$1 and job_type='text.interpret'", [caseId]))[0]?.status;
    if (st !== 'pending') break;
    run = n8nRun(WF04);
  }
  const c = (await sql('select status from cases where id=$1', [caseId]))[0];
  const p = (await sql('select id::text, source, proposed_data from case_proposals where case_id=$1 order by version desc limit 1', [caseId]))[0];
  const h = (await sql('select id::text, decision_type, status, options from hitl_requests where case_id=$1', [caseId]))[0];
  return { caseId, caseStatus: c?.status, proposal: p, hitl: h, run };
}
export async function decide(token, hitlId, decision = 'approved', comment) {
  return http('POST', `/hitl-requests/${hitlId}/decision`, { token, body: { decision, ...(comment ? { comment } : {}) } });
}
export async function apply(token, caseId, proposalId) {
  return http('POST', `/cases/${caseId}/proposals/${proposalId}/apply`, { token, body: {} });
}

/** Procesa la cola de textos pendientes (una ejecución de n8n por trabajo) hasta vaciarla. */
export async function drainQueue(max = 12) {
  for (let i = 0; i < max; i += 1) {
    const n = Number((await sql("select count(*)::int n from workflow_jobs where status='pending' and job_type in ('text.interpret','voice.transcribe')"))[0].n);
    if (n === 0) return i;
    n8nRun(WF04);
  }
  return max;
}

export const WF02 = 'nhpDocProcess001';
export const WF06 = 'nhpMaintSched001';

/** Ejecuta el workflow 03 (un trabajo hitl.decision por ejecución, el más antiguo) hasta cerrar el caso. */
export async function closeCase(caseId, max = 12) {
  for (let i = 0; i < max; i += 1) {
    const st = (await sql('select status from cases where id=$1', [caseId]))[0]?.status;
    if (st !== 'processing' && st !== 'awaiting_human') return st;
    n8nRun(WF03);
  }
  return (await sql('select status from cases where id=$1', [caseId]))[0]?.status;
}
