/**
 * Banco de pruebas 100 % local del workflow 04 (voz) con el BACKEND REAL compilado:
 *   PostgreSQL 18 desechable + `node dist/main` + proxy con fallos inyectados
 *   + n8n desechable. Gemini se simula en el proxy; la credencial es falsa.
 * No lee backend/.env, exige base local y no puede llamar a Gemini ni a Neon.
 *
 * Requisitos: Docker, `npm run build` en backend/ y ffmpeg (en el PATH o en la
 * variable FFMPEG) para generar los formatos mp3/ogg/webm/m4a y el audio grande.
 * Audios ficticios: n8n/test-data/audio/ (voz sintética y un tono).
 * Uso: node n8n/tests/voice-stack.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const AUDIO = join(REPO, 'n8n/test-data/audio');
const BACKEND = join(REPO, 'backend');
const require = createRequire(`${BACKEND}/`);
const pg = require('pg');
const PG_PORT = 55437;
const API_PORT = 3997;
const PROXY_PORT = 18767;
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const REMOTE = `http://host.docker.internal:${PROXY_PORT}`;
const PG_NAME = 'notihouse-voice-pg';
const N8N_NAME = 'notihouse-voice-n8n';
const IMAGE = 'docker.n8n.io/n8nio/n8n:2.46.6';
const pgPassword = randomBytes(18).toString('base64url');
const serviceToken = randomBytes(48).toString('base64url');
const jwtSecret = randomBytes(48).toString('base64url');
const DATABASE_URL = `postgresql://postgres:${pgPassword}@127.0.0.1:${PG_PORT}/notihouse`;
if (!/@127\.0\.0\.1:/.test(DATABASE_URL)) throw new Error('Destino no local');

const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// Todo lo generado vive en un directorio temporal del sistema que se borra al terminar.
const ROOT = mkdtempSync(join(tmpdir(), 'notihouse-voice-'));
const WORK = join(ROOT, 'work');
mkdirSync(WORK, { recursive: true });
const FILES = join(ROOT, 'files');
mkdirSync(FILES, { recursive: true });
const FF = process.env.FFMPEG || 'ffmpeg';

let db; let apiProcess; let proxyServer;
async function cleanup() {
  try { await db?.end(); } catch { /* ya cerrada */ }
  apiProcess?.kill();
  proxyServer?.close();
  docker('rm', '-f', N8N_NAME);
  docker('rm', '-f', PG_NAME);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* el sistema limpia el temporal */ }
}

// ---------------------------------------------------- audios de prueba (ffmpeg local)
const ff = (...a) => { const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
const voiceWav = join(AUDIO, 'nota-voz-agua.wav');
const toneWav = join(AUDIO, 'tono-3s.wav');
const fmt = {
  mp3: join(WORK, 'a.mp3'), ogg: join(WORK, 'a.ogg'), webm: join(WORK, 'a.webm'), m4a: join(WORK, 'a.m4a'), big: join(WORK, 'big.wav'),
};
ff('-i', voiceWav, '-t', '3', '-c:a', 'libmp3lame', '-b:a', '32k', fmt.mp3);
ff('-i', voiceWav, '-t', '3', '-c:a', 'libopus', '-b:a', '24k', fmt.ogg);
ff('-i', voiceWav, '-t', '3', '-c:a', 'libopus', '-b:a', '24k', fmt.webm);
ff('-i', voiceWav, '-t', '3', '-c:a', 'aac', '-b:a', '32k', '-f', 'ipod', fmt.m4a);
// 15 MiB de silencio: supera el límite del envío directo (13 MiB) pero no el del backend (25 MiB).
ff('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '178', '-c:a', 'pcm_s16le', fmt.big);

// ---------------------------------------------------- PostgreSQL y migraciones
docker('rm', '-f', PG_NAME);
const pgStart = docker('run', '-d', '--rm', '--name', PG_NAME, '-p', `127.0.0.1:${PG_PORT}:5432`,
  '--tmpfs', '/var/lib/postgresql', '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', 'POSTGRES_DB=notihouse', 'postgres:18');
if (pgStart.status !== 0) throw new Error(pgStart.stderr);
db = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
db.on('error', () => undefined);
for (let i = 0; ; i += 1) {
  try { await db.query('SELECT 1'); await sleep(1500); await db.query('SELECT 1'); break; } catch (e) {
    if (i > 40) throw e;
    await sleep(1000);
  }
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const migrations = join(REPO, 'database/migrations');
for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
  for (const statement of readFileSync(join(migrations, file), 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) await db.query(statement);
  }
}
console.log('PostgreSQL desechable listo y migraciones aplicadas');

// ---------------------------------------------------- Backend real
apiProcess = spawn('node', ['--no-warnings', join(BACKEND, 'dist/main.js')], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'development', PORT: String(API_PORT), DATABASE_URL, JWT_SECRET: jwtSecret, N8N_SERVICE_TOKEN: serviceToken,
    STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: join(FILES, 'storage'), STORAGE_UPLOAD_TMP_PATH: join(FILES, 'tmp'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let apiErr = '';
apiProcess.stderr.on('data', (d) => { apiErr += d; });
for (let i = 0; ; i += 1) {
  const r = await fetch(`${API}/health/ready`).catch(() => null);
  if (r?.status === 200) break;
  if (i > 40) { console.log(apiErr.slice(-800)); await cleanup(); throw new Error('La API local no arrancó'); }
  await sleep(1000);
}
console.log('Backend real en local listo');

// ---------------------------------------------------- Usuarios y clientes
const { hashPassword } = await import(pathToFileURL(join(BACKEND, 'dist/auth/password.js')));
const { parseProposalAction } = await import(pathToFileURL(join(BACKEND, 'dist/cases/proposal-actions.js')));
async function makeUser(name) {
  const email = `${name}@notihouse.test`;
  const password = randomBytes(12).toString('base64url');
  const [{ id: profileId }] = await q(`INSERT INTO profiles (display_name) VALUES ($1) RETURNING id`, [name]);
  await q(`INSERT INTO auth_accounts (profile_id, email, password_hash) VALUES ($1, $2, $3)`, [profileId, email, await hashPassword(password)]);
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (res.status !== 200) throw new Error(`login ${res.status}`);
  return { profileId, jwt: (await res.json()).accessToken };
}
const daniel = await makeUser('daniel-local');
const ana = await makeUser('ana-local');

const request = async (method, path, token, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
  return { status: res.status, body: json };
};
const userOf = (u) => (m, p, b) => request(m, p, u.jwt, b);
const user = userOf(daniel);
const svc = (m, p, b) => request(m, p, serviceToken, b);
const uniq = () => randomUUID().slice(0, 8);

async function ingestVoice(file, { mime = 'audio/wav', name = 'nota.wav', u = daniel, requestId = randomUUID() } = {}) {
  const bytes = readFileSync(file);
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: mime }));
  form.append('requestId', requestId);
  const res = await fetch(`${API}/ingestions/voice`, { method: 'POST', headers: { Authorization: `Bearer ${u.jwt}` }, body: form });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body, sha: sha256(bytes), size: bytes.length };
}

const caseOf = async (id) => (await q(`SELECT status::text AS status, status_reason, closed_at, owner_id FROM cases WHERE id = $1`, [id]))[0];
const jobOf = async (caseId, type = 'voice.transcribe') => (await q(`SELECT id, status::text AS status, attempts, last_error, result FROM workflow_jobs WHERE case_id = $1 AND job_type = $2`, [caseId, type]))[0];
const proposalsOf = (caseId) => q(`SELECT id, version, source::text AS source, review_status::text AS status, proposed_data, evidence FROM case_proposals WHERE case_id = $1 ORDER BY version`, [caseId]);
const hitlOf = async (caseId) => (await q(`SELECT id, status::text AS status, decision_type::text AS type, options, proposal_id FROM hitl_requests WHERE case_id = $1`, [caseId]));
const actions = async (correlationId) => (await q(`SELECT action FROM audit_events WHERE correlation_id = $1 ORDER BY occurred_at, id`, [correlationId])).map((a) => a.action);
const count = async (t) => Number((await q(`SELECT count(*) AS n FROM ${t}`))[0].n);
const drain = () => q(`UPDATE workflow_jobs SET status = 'cancelled', locked_until = NULL WHERE job_type IN ('voice.transcribe','hitl.decision','document.process') AND status IN ('pending','claimed')`);
const decide = (hitlId, decision, u = daniel) => userOf(u)('POST', `/hitl-requests/${hitlId}/decision`, { decision, comment: 'Aprobación técnica de prueba' });
const apply = (caseId, proposalId, u = daniel) => userOf(u)('POST', `/cases/${caseId}/proposals/${proposalId}/apply`, {});
const readyAgain = (caseId) => q(`UPDATE workflow_jobs SET available_at = now() - interval '1 second' WHERE case_id = $1`, [caseId]);

// ---------------------------------------------------- Proxy con fallos + Gemini simulado
const wf = JSON.parse(readFileSync(join(REPO, 'n8n/workflows/04-procesamiento-voz.json'), 'utf8'));
const preCfg = (() => {
  const code = wf.nodes.find((n) => n.name === 'Configuracion').parameters.jsCode;
  return { tone: /PREFLIGHT_TONE_B64 = '([^']+)'/.exec(code)[1] };
})();
const VOICE_TEXT = 'Quiero registrar una obligación de prueba del servicio de agua. El proveedor es Agua de Prueba S.A.S. El valor es cuarenta y tres mil doscientos pesos colombianos. Corresponde al período del primero al treinta de noviembre de dos mil veintiséis, y vence el doce de diciembre de dos mil veintiséis. Todavía no está pagada.';
const stt = (o = {}) => ({ hasSpeech: true, language: 'es', transcript: VOICE_TEXT, uncertainFragments: [], ...o });
const FULL = {
  isObligationInstruction: true, providerName: 'Agua de Prueba S.A.S.', concept: 'servicio de agua', category: 'water',
  periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-12', amount: '43200.00', currency: 'COP',
  paymentStatus: 'pending', missing: [], ambiguities: [],
  evidence: [{ field: 'amount', text: 'cuarenta y tres mil doscientos pesos colombianos' }, { field: 'providerName', text: 'Agua de Prueba S.A.S.' }],
};
const PRE_STT = { hasSpeech: true, language: 'es', transcript: 'Prueba de comprobación. Obligación del servicio de gas. El proveedor es Empresa Ficticia de Comprobación. El valor es mil quinientos pesos colombianos. Vence el quince de noviembre de dos mil veintiséis.', uncertainFragments: [] };
const PRE_INTERP = { ...FULL, providerName: 'Empresa Ficticia de Comprobación', concept: 'servicio de gas', category: 'gas', periodStart: null, periodEnd: null, dueDate: '2026-11-15', amount: '1500.00', missing: ['periodo'], evidence: [] };

let sc = {};
let log = [];
let fault = null;
const geminiReply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const okJson = (obj) => ({ modelVersion: 'simulado', candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ thought: true, text: 'razonamiento ignorado' }, { text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] });
const DAILY_429 = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. Please retry in 10h53m45.990387125s.', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-2.5-flash' }, quotaValue: '20' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '39225s' }] } };
const geminiFail = (res, status) => geminiReply(res, status, { error: { code: status, status: 'ERROR', message: 'error simulado' } });
const once = (key) => { if (sc[key] > 0) { sc[key] -= 1; return true; } return false; };

proxyServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const raw = Buffer.concat(chunks);
    if (/generateContent$/.test(path)) {
      const body = JSON.parse(raw.toString());
      const parts = body.contents?.[0]?.parts ?? [];
      const audioPart = parts.find((p) => p.inlineData);
      const textPart = parts.find((p) => p.text)?.text ?? '';
      const entry = { method: 'POST', path: '/gemini', status: 200, hasSchema: body.generationConfig?.responseMimeType === 'application/json', keyOk: url.searchParams.get('key') === 'clave-falsa', model: /models\/([^:]+):/.exec(path)?.[1] };
      log.push(entry);
      if (!entry.keyOk) { entry.status = 400; return geminiFail(res, 400); }
      if (audioPart) {
        entry.kind = 'transcribe';
        entry.mime = audioPart.inlineData.mimeType;
        entry.audioSha = sha256(Buffer.from(audioPart.inlineData.data, 'base64'));
        if (audioPart.inlineData.data === preCfg.tone) {
          entry.kind = 'pre-tono';
          if (sc.probe429) { entry.status = 429; return geminiReply(res, 429, DAILY_429); }
          if (sc.probeSpeech) return geminiReply(res, 200, okJson(PRE_STT));
          return geminiReply(res, 200, okJson(stt({ hasSpeech: false, language: null, transcript: '' })));
        }
        if (sc.stt429Daily) { entry.status = 429; return geminiReply(res, 429, DAILY_429); }
        if (once('sttFail')) { entry.status = sc.sttStatus; return geminiFail(res, sc.sttStatus); }
        if (sc.sttRaw !== undefined) return geminiReply(res, 200, okJson(sc.sttRaw));
        if (sc.sttBlocked) return geminiReply(res, 200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
        return geminiReply(res, 200, okJson(sc.stt ?? stt()));
      }
      entry.kind = 'interpret';
      entry.textSent = textPart;
      if (once('interpFail')) { entry.status = sc.interpStatus; return geminiFail(res, sc.interpStatus); }
      if (sc.interpRaw !== undefined) return geminiReply(res, 200, okJson(sc.interpRaw));
      return geminiReply(res, 200, okJson(sc.interp ?? FULL));
    }
    const hit = fault && fault.times > 0 && new RegExp(fault.match).test(path);
    if (hit && fault.mode !== 'after') {
      fault.times -= 1;
      log.push({ method: req.method, path: path.replace('/api/v1', ''), status: fault.status, injected: true });
      res.writeHead(fault.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ statusCode: fault.status, message: 'fallo inyectado', error: 'Error' }));
      return;
    }
    const headers = { ...req.headers, host: `127.0.0.1:${API_PORT}` };
    delete headers['content-length'];
    const upstream = await fetch(`http://127.0.0.1:${API_PORT}${req.url}`, { method: req.method, headers, body: raw.length ? raw : undefined });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (hit) {
      fault.times -= 1;
      log.push({ method: req.method, path: path.replace('/api/v1', ''), status: fault.status, injected: 'respuesta perdida', real: upstream.status });
      res.writeHead(fault.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ statusCode: fault.status, message: 'respuesta perdida', error: 'Error' }));
      return;
    }
    log.push({ method: req.method, path: path.replace('/api/v1', ''), status: upstream.status, bytes: body.length, sent: raw.length ? JSON.parse(raw.toString() || '{}') : undefined });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', ...(upstream.headers.get('content-disposition') ? { 'content-disposition': upstream.headers.get('content-disposition') } : {}) });
    res.end(body);
  });
});
await new Promise((r) => proxyServer.listen(PROXY_PORT, '127.0.0.1', r));

// ---------------------------------------------------- n8n desechable
const redirect = (file, id, authorized) => {
  const w = JSON.parse(readFileSync(join(REPO, 'n8n/workflows', file), 'utf8'));
  const config = w.nodes.find((n) => n.name === 'Configuracion');
  let code = config.parameters.jsCode
    .replace('https://notihouse-pal-api.onrender.com/api/v1', `${REMOTE}/api/v1`)
    .replace('https://generativelanguage.googleapis.com', REMOTE);
  if (authorized) code = code.replace('AUTORIZAR_RECLAMACION = false', 'AUTORIZAR_RECLAMACION = true');
  config.parameters.jsCode = code;
  w.id = id;
  w.name = id;
  writeFileSync(join(WORK, `${id}.json`), JSON.stringify(w));
};
redirect('04-procesamiento-voz.json', 'test04Open000001', true);
redirect('04-procesamiento-voz.json', 'test04Closed0001', false);
redirect('03-cierre-hitl.json', 'test03Open000001', true);
writeFileSync(join(WORK, 'creds.json'), JSON.stringify([
  { id: 'nhpApiService001', name: 'NotiHouse-Pal API (servicio)', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${serviceToken}` } },
  { id: 'V3F6GYNAb2ExkptK', name: 'Google Gemini(PaLM) Api account', type: 'googlePalmApi', data: { host: REMOTE, apiKey: 'clave-falsa' } },
]));
docker('rm', '-f', N8N_NAME);
docker('run', '-d', '--name', N8N_NAME, '--add-host', 'host.docker.internal:host-gateway', '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-v', `${WORK}:/work:ro`, '--entrypoint', 'sh', IMAGE, '-c', 'sleep 7200');
const inside = (cmd) => docker('exec', N8N_NAME, 'sh', '-c', cmd);
for (const cmd of ['n8n import:credentials --input=/work/creds.json', ...['test04Open000001', 'test04Closed0001', 'test03Open000001'].map((f) => `n8n import:workflow --input=/work/${f}.json`)]) {
  console.log(`  ${inside(`${cmd} 2>&1 | tail -1`).stdout.trim()}`);
}
writeFileSync(join(WORK, 'creds.json'), '[]');

const run = async (id = 'test04Open000001', f = null, scenario = {}) => {
  log = [];
  sc = { ...scenario };
  fault = f ? { times: 1, mode: 'before', ...f } : null;
  const r = await new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', N8N_NAME, 'sh', '-c', `n8n execute --id ${id} --rawOutput > /tmp/o.txt 2>&1; echo EXIT=$?; grep -E '"message":' /tmp/o.txt | head -1`]);
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', () => resolve({ stdout }));
  });
  fault = null;
  return { exit: Number(/EXIT=(\d+)/.exec(r.stdout)?.[1] ?? -1), message: r.stdout, log: [...log] };
};
const clean = (p) => p.replace(/[0-9a-f-]{36}/g, ':id');
const pathsOf = (l) => l.filter((e) => e.path !== '/gemini').map((e) => `${clean(e.path)}=${e.status}`).join(' > ');
const gem = (l) => l.filter((e) => e.path === '/gemini');
const has = (l, part) => l.some((e) => e.path.includes(part));
const real = (l) => gem(l).filter((e) => !String(e.kind).startsWith('pre-'));
const CLAIM_RE = '/workflow-jobs/claim$';
const PROPOSALS_RE = '/proposals$';

let failed = 0; let total = 0;
const check = (name, ok, detail = '') => {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK ' : 'ERR'} ${name}${detail && !ok ? ` | ${detail}` : ''}`);
};
/** Ingesta + ejecución del workflow 04. */
async function ingestAndRun(file = voiceWav, opts = {}, scenario = {}, f = null) {
  await drain();
  const ing = await ingestVoice(file, opts);
  const r = await run('test04Open000001', f, scenario);
  return { ing, r };
}

try {
  // ---------- 0. Interruptor y cola
  { await drain();
    const ing = await ingestVoice(voiceWav);
    const r = await run('test04Closed0001');
    const job = await jobOf(ing.caseId);
    check('Interruptor en false: solo el preflight, sin tocar la API', r.exit === 0 && r.log.filter((e) => e.path !== '/gemini').length === 0 && job.status === 'pending' && job.attempts === 0, pathsOf(r.log));
    check('Sondeo: UNA sola llamada a Gemini (tono), con JSON estructurado y gemini-2.5-flash', gem(r.log).map((e) => e.kind).join(',') === 'pre-tono' && gem(r.log).every((e) => e.hasSchema && e.model === 'gemini-2.5-flash'), gem(r.log).map((e) => e.kind).join(','));
    const empty = await drain() && await run('test04Open000001');
    check('Cola vacía: reclama, no encuentra nada y no escribe', empty.exit === 0 && has(empty.log, 'claim') && !has(empty.log, '/proposals') && !has(empty.log, '/complete'), pathsOf(empty.log));
  }

  // ---------- 0b. Cuota diaria agotada (429 con la forma real de Google)
  { await drain(); const ing = await ingestVoice(voiceWav);
    const r = await run('test04Open000001', null, { probe429: true });
    const job = await jobOf(ing.caseId);
    check('Sondeo con 429 de cuota diaria: se detiene ANTES de reclamar (0 intentos, sin llamadas a la API)', r.exit === 1 && job.status === 'pending' && job.attempts === 0 && r.log.filter((e) => e.path !== '/gemini').length === 0 && gem(r.log).length === 1, `${r.exit} ${job.status} ${job.attempts} ${pathsOf(r.log)} gemini=${gem(r.log).length}`);
    check('Sondeo con 429: el mensaje indica cuota diaria y el plazo de reintento', /DIARIA/.test(r.message) && /10h53m45s/.test(r.message), r.message.slice(0, 260));
    const r2 = await run('test04Open000001', null, { stt429Daily: true });
    const job2 = await jobOf(ing.caseId);
    check('429 diario al transcribir: un intento, reintentable, motivo con cuota y plazo; sin propuestas', r2.exit === 1 && job2.status === 'pending' && job2.attempts === 1 && /DIARIA/.test(job2.last_error) && /10h53m45s/.test(job2.last_error) && (await proposalsOf(ing.caseId)).length === 0, `${job2.status} ${job2.attempts} ${job2.last_error}`);
    check('429 diario: gemini-2.5-flash en todas las llamadas (no cambia de modelo)', gem(r2.log).every((e) => e.model === 'gemini-2.5-flash'));
  }
  { await drain(); const ing = await ingestVoice(toneWav, { name: 'tono.wav' });
    const r = await run('test04Open000001', null, { probeSpeech: true });
    check('El sondeo detecta un tono con "voz" inventada y no reclama', r.exit === 1 && (await jobOf(ing.caseId)).attempts === 0 && r.log.filter((e) => e.path !== '/gemini').length === 0, pathsOf(r.log));
  }

  // ---------- 1. Voz clara con todos los campos (camino feliz completo)
  let happy;
  { const { ing, r } = await ingestAndRun(voiceWav);
    check('Ingesta de voz real (WAV): 201 y trabajo voice.transcribe', ing.status === 201 && ing.job.type === 'voice.transcribe' && ing.mimeType === 'audio/wav', JSON.stringify(ing).slice(0, 200));
    const job = await jobOf(ing.caseId); const ps = await proposalsOf(ing.caseId); const hs = await hitlOf(ing.caseId); const c = await caseOf(ing.caseId);
    check('Feliz: orden de llamadas', pathsOf(r.log) === '/health=200 > /health/ready=200 > /internal/workflow-jobs/claim=200 > /internal/documents/:id/content=200 > /internal/cases/:id/proposals=201 > /internal/cases/:id/proposals=201 > /internal/cases/:id/hitl-requests=201 > /internal/workflow-jobs/:id/complete=200', pathsOf(r.log));
    check('Feliz: el audio llega íntegro a Gemini (mismo SHA-256, audio/wav)', real(r.log)[0].audioSha === ing.sha && real(r.log)[0].mime === 'audio/wav', `${real(r.log)[0].audioSha} ${ing.sha}`);
    check('Feliz: dos llamadas reales a Gemini (transcribir e interpretar)', real(r.log).map((e) => e.kind).join(',') === 'transcribe,interpret');
    check('Feliz: la interpretación recibe la transcripción, no el audio', real(r.log)[1].textSent.includes('Agua de Prueba S.A.S.') && !real(r.log)[1].textSent.includes('RIFF'));
    check('Feliz: trabajo completed con 1 intento; caso awaiting_human', job.status === 'completed' && job.attempts === 1 && c.status === 'awaiting_human', `${job.status} ${job.attempts} ${c.status}`);
    check('Feliz: propuesta stt (evidencia) v1 superseded y llm v2 pendiente', ps.length === 2 && ps[0].source === 'stt' && ps[0].status === 'superseded' && ps[1].source === 'llm' && ps[1].status === 'pending_review');
    check('Feliz: la transcripción es la oída, sin interpretar', ps[0].proposed_data.transcript === VOICE_TEXT && ps[0].proposed_data.action === undefined);
    let parsed = null; try { parsed = await parseProposalAction(ps[1].proposed_data); } catch (e) { parsed = e.message; }
    check('Feliz: la propuesta llm pasa parseProposalAction real', parsed?.action === 'create_obligation_with_occurrence', String(parsed));
    const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
    check('Feliz: datos exactos', canon(ps[1].proposed_data) === canon({ action: 'create_obligation_with_occurrence', data: { obligation: { providerName: 'Agua de Prueba S.A.S.', concept: 'servicio de agua', category: 'water', expectedAmount: '43200.00', currency: 'COP' }, occurrence: { periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-12', amount: '43200.00' } } }), JSON.stringify(ps[1].proposed_data));
    check('Feliz: revisión data_confirmation pendiente, sin alternativas, ligada a la llm', hs.length === 1 && hs[0].type === 'data_confirmation' && hs[0].status === 'pending' && hs[0].proposal_id === ps[1].id && !hs[0].options.choices);
    const a = await actions(ing.correlationId);
    check('Feliz: auditoría completa y sin pagos', ['voice_note.receive', 'workflow_job.claim', 'document.content_access', 'case_proposal.create', 'hitl_request.create', 'workflow_job.complete'].every((x) => a.includes(x)) && !a.some((x) => /confirm|paid|apply/.test(x)), a.join(','));
    happy = { ing, ps, hs };
  }
  // Aprobar -> aplicar -> workflow 03
  { const { ing, ps, hs } = happy;
    const before = { o: await count('obligations'), p: await count('obligation_occurrences') };
    const stt409 = await apply(ing.caseId, ps[0].id);
    check('stt no se aplica (aunque se intente): 409', stt409.status === 409, `${stt409.status}`);
    const none = await apply(ing.caseId, ps[1].id);
    check('Sin aprobación no se aplica: 409', none.status === 409 && (await count('obligations')) === before.o);
    const svcDecide = await svc('POST', `/hitl-requests/${hs[0].id}/decision`, { decision: 'approved' });
    check('n8n (token de servicio) no puede decidir: 401', svcDecide.status === 401);
    const aDecide = await decide(hs[0].id, 'approved', ana);
    check('Otro usuario no puede decidir la revisión de Daniel', [403, 404].includes(aDecide.status), String(aDecide.status));
    const d = await decide(hs[0].id, 'approved');
    check('Aprobación humana: 200 y todavía no hay obligación', d.status === 200 && (await count('obligations')) === before.o);
    const ap = await apply(ing.caseId, ps[1].id);
    check('Aplicación: 201, una obligación y un período', ap.status === 201 && (await count('obligations')) === before.o + 1 && (await count('obligation_occurrences')) === before.p + 1, `${ap.status} ${JSON.stringify(ap.body).slice(0, 150)}`);
    const [occ] = await q(`SELECT status::text AS s, confirmed_at, amount, due_date::text AS due, owner_id FROM obligation_occurrences WHERE id = $1`, [ap.body.resource.id]);
    check('Período pending, 43200.00, vence 2026-12-12, sin pago confirmado, de Daniel', occ.s === 'pending' && occ.confirmed_at === null && occ.amount === '43200.00' && occ.due === '2026-12-12' && occ.owner_id === daniel.profileId);
    const r3 = await run('test03Open000001');
    const c = await caseOf(ing.caseId);
    check('Workflow 03: cierra el caso (completed)', r3.exit === 0 && c.status === 'completed' && (await jobOf(ing.caseId, 'hitl.decision')).status === 'completed', pathsOf(r3.log));
    check('Reaplicar: 200 alreadyApplied, sin duplicados', (await apply(ing.caseId, ps[1].id)).body.alreadyApplied === true && (await count('obligations')) === before.o + 1);
    const a = await actions(ing.correlationId);
    const idx = (n) => a.indexOf(n);
    const applyOk = a.indexOf('case_proposal.apply', idx('hitl_request.approve'));
    check('Orden en la auditoría: aprobar → aplicar → cerrar', idx('hitl_request.approve') > -1 && applyOk > idx('hitl_request.approve') && a.lastIndexOf('case.status_change') > applyOk && a.indexOf('obligation.create') > idx('hitl_request.approve'), a.join(','));
  }

  // ---------- 2. Rechazo humano: nada se crea
  { const { ing } = await ingestAndRun(voiceWav);
    const [h] = await hitlOf(ing.caseId); const before = await count('obligations');
    const d = await decide(h.id, 'rejected');
    const r3 = await run('test03Open000001');
    check('Rechazo: caso completed y ninguna obligación nueva', d.status === 200 && r3.exit === 0 && (await caseOf(ing.caseId)).status === 'completed' && (await count('obligations')) === before);
    const ps = await proposalsOf(ing.caseId);
    check('Rechazo: la propuesta llm queda rejected y no se puede aplicar', ps[1].status === 'rejected' && (await apply(ing.caseId, ps[1].id)).status === 409);
  }

  // ---------- 3. Sin voz: tono, transcripción vacía, texto residual
  for (const [name, file, scenario] of [
    ['Tono sin voz (hasSpeech=false)', toneWav, { stt: stt({ hasSpeech: false, language: null, transcript: '' }) }],
    ['Transcripción vacía con hasSpeech=true', toneWav, { stt: stt({ transcript: '   ' }) }],
    ['hasSpeech=false pero con texto inventado', toneWav, { stt: stt({ hasSpeech: false, transcript: 'hola hola hola hola' }) }],
  ]) {
    const { ing, r } = await ingestAndRun(file, { name: 'tono.wav' }, scenario);
    const job = await jobOf(ing.caseId); const c = await caseOf(ing.caseId); const a = await actions(ing.correlationId);
    check(`${name}: no se crea ninguna propuesta ni revisión`, (await proposalsOf(ing.caseId)).length === 0 && (await hitlOf(ing.caseId)).length === 0 && real(r.log).length === 1, `${(await proposalsOf(ing.caseId)).length}`);
    check(`${name}: trabajo failed (sin reintento), 1 intento; caso failed con motivo`, job.status === 'failed' && job.attempts === 1 && c.status === 'failed' && /no contiene voz/.test(job.last_error), `${job.status} ${job.attempts} ${job.last_error}`);
    check(`${name}: nunca queda como exitoso; auditoría coherente`, job.status !== 'completed' && a.includes('workflow_job.fail') && !a.includes('workflow_job.complete') && !a.includes('case_proposal.create'), a.join(','));
    check(`${name}: la ejecución termina con error visible`, r.exit === 1, String(r.exit));
  }

  // ---------- 4. Interpretaciones insuficientes, ambiguas o con importe en otro formato
  const nonApplicable = [
    ['Faltan datos (sin período ni vencimiento)', { ...FULL, periodStart: null, periodEnd: null, dueDate: null, missing: ['periodo', 'vencimiento'] }],
    ['Fecha ambigua', { ...FULL, dueDate: null, ambiguities: ['"el doce" sin mes ni año'] }],
    ['Importe con separador de miles', { ...FULL, amount: '43.200' }],
    ['Moneda no dicha', { ...FULL, currency: null, missing: ['moneda'] }],
    ['Proveedor inventado (no está en la transcripción)', { ...FULL, providerName: 'Acueducto Inventado S.A.' }],
    ['La nota dice que ya está pagada', { ...FULL, paymentStatus: 'paid' }],
    ['No es una instrucción de obligación', { ...FULL, isObligationInstruction: false }],
    ['Valor cero', { ...FULL, amount: '0.00' }],
  ];
  for (const [name, interp] of nonApplicable) {
    const before = { o: await count('obligations'), p: await count('obligation_occurrences') };
    const { ing, r } = await ingestAndRun(voiceWav, {}, { interp });
    const ps = await proposalsOf(ing.caseId); const [h] = await hitlOf(ing.caseId); const job = await jobOf(ing.caseId);
    check(`${name}: propuesta no aplicable + revisión "other"`, r.exit === 0 && ps.length === 2 && ps[1].proposed_data.requiereRevisionManual === true && !ps[1].proposed_data.action && h.type === 'other' && job.status === 'completed', `${r.exit} ${pathsOf(r.log)}`);
    if (name.startsWith('Faltan')) {
      await decide(h.id, 'approved');
      check('Aprobar una propuesta no aplicable no crea nada (apply 409)', (await apply(ing.caseId, ps[1].id)).status === 409 && (await count('obligations')) === before.o && (await count('obligation_occurrences')) === before.p);
      await run('test03Open000001');
    }
    check(`${name}: sin datos financieros nuevos`, (await count('obligations')) === before.o && (await count('obligation_occurrences')) === before.p);
  }
  check('Ninguna ejecución de la etapa confirmó pagos', Number((await q(`SELECT count(*) AS n FROM obligation_occurrences WHERE confirmed_at IS NOT NULL OR status::text IN ('paid','attended')`))[0].n) === 0);

  { const { ing, r } = await ingestAndRun(voiceWav, {}, { stt: stt({ transcript: VOICE_TEXT.replace('S.A.S.', 'SAS') }) });
    const ps = await proposalsOf(ing.caseId);
    check('Transcripción "SAS" e interpretación "S.A.S.": sigue siendo aplicable', r.exit === 0 && ps[1].proposed_data.action === 'create_obligation_with_occurrence', JSON.stringify(ps[1]?.proposed_data).slice(0, 120));
  }

  // ---------- 5. Salidas inválidas de Gemini
  { const { ing, r } = await ingestAndRun(voiceWav, {}, { sttRaw: 'esto no es JSON' });
    const job = await jobOf(ing.caseId); const c = await caseOf(ing.caseId);
    check('JSON inválido en la transcripción: fallo temporal, intento 1, vuelve a pending', r.exit === 1 && job.status === 'pending' && job.attempts === 1 && c.status === 'processing' && (await proposalsOf(ing.caseId)).length === 0, `${job.status} ${job.attempts}`);
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, { interpRaw: 'tampoco es JSON' });
    const job = await jobOf(ing.caseId); const ps = await proposalsOf(ing.caseId);
    check('JSON inválido en la interpretación: reintentable; la transcripción queda como evidencia', r.exit === 1 && job.status === 'pending' && job.attempts === 1 && ps.length === 1 && ps[0].source === 'stt' && (await hitlOf(ing.caseId)).length === 0, `${job.status} ${ps.length}`);
    await readyAgain(ing.caseId);
    const again = await run('test04Open000001', null, {});
    const job2 = await jobOf(ing.caseId); const ps2 = await proposalsOf(ing.caseId);
    check('Reintento tras el fallo: completa en el intento 2 sin duplicar la evidencia', again.exit === 0 && job2.status === 'completed' && job2.attempts === 2 && ps2.filter((p) => p.source === 'stt').length === 1 && ps2.length === 2, `${job2.status} ${job2.attempts} ${ps2.map((p) => p.source + p.version)}`);
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, { sttBlocked: true });
    const job = await jobOf(ing.caseId);
    check('Gemini bloquea el contenido: fallo definitivo', r.exit === 1 && job.status === 'failed' && job.attempts === 1 && (await caseOf(ing.caseId)).status === 'failed');
  }
  for (const [name, scenario, expect] of [
    ['429 al transcribir', { sttFail: 99, sttStatus: 429 }, 'pending'],
    ['503 al transcribir', { sttFail: 99, sttStatus: 503 }, 'pending'],
    ['400 al transcribir', { sttFail: 99, sttStatus: 400 }, 'failed'],
    ['429 al interpretar', { interpFail: 99, interpStatus: 429 }, 'pending'],
    ['503 al interpretar', { interpFail: 99, interpStatus: 503 }, 'pending'],
  ]) {
    const { ing, r } = await ingestAndRun(voiceWav, {}, scenario);
    const job = await jobOf(ing.caseId);
    check(`${name}: ${expect === 'pending' ? 'reintentable' : 'definitivo'}, un solo intento gastado, UNA llamada a Gemini, sin cambiar de modelo`, r.exit === 1 && job.status === expect && job.attempts === 1 && real(r.log).length === (name.includes('interpretar') ? 2 : 1) && gem(r.log).every((e) => e.model === 'gemini-2.5-flash'), `${job.status} ${job.attempts} ${r.message.slice(0, 120)}`);
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, { sttFail: 1, sttStatus: 503 });
    check('503 de Gemini: UNA sola llamada (sin reintento en el nodo); el trabajo se reintenta a su nivel', r.exit === 1 && real(r.log).length === 1 && (await jobOf(ing.caseId)).status === 'pending' && (await jobOf(ing.caseId)).attempts === 1);
    await readyAgain(ing.caseId);
    const again = await run('test04Open000001', null, {});
    check('Tras el 503, el siguiente intento completa (intento 2)', again.exit === 0 && (await jobOf(ing.caseId)).status === 'completed' && (await jobOf(ing.caseId)).attempts === 2);
  }

  // ---------- 6. Fallos del backend: 401, 409, 503, respuestas perdidas
  { await drain(); const ing = await ingestVoice(voiceWav);
    const r = await run('test04Open000001', { match: CLAIM_RE, status: 401 });
    const job = await jobOf(ing.caseId);
    check('401 al reclamar: se detiene sin gastar intento', r.exit === 1 && job.status === 'pending' && job.attempts === 0 && !has(r.log, '/fail'), pathsOf(r.log));
    const r2 = await run('test04Open000001', { match: PROPOSALS_RE, status: 401, times: 9 });
    check('401 al registrar: no llama a fail', r2.exit === 1 && !has(r2.log, '/fail'), pathsOf(r2.log));
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, {}, { match: '/documents/[^/]+/content$', status: 409, times: 9 });
    check('409 al descargar: abandona sin llamar a fail', r.exit === 1 && !has(r.log, '/fail') && real(r.log).length === 0, pathsOf(r.log));
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, {}, { match: '/documents/[^/]+/content$', status: 503 });
    check('503 pasajero al descargar: reintenta y completa', r.exit === 0 && (await jobOf(ing.caseId)).status === 'completed', pathsOf(r.log));
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, {}, { match: '/documents/[^/]+/content$', status: 503, times: 9 });
    const job = await jobOf(ing.caseId);
    check('503 persistente al descargar: fail reintentable, nada enviado a Gemini', r.exit === 1 && job.status === 'pending' && job.attempts === 1 && real(r.log).length === 0, pathsOf(r.log));
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, {}, { match: PROPOSALS_RE, status: 503, mode: 'after' });
    const ps = await proposalsOf(ing.caseId);
    check('Respuesta perdida al registrar la transcripción: reintento sin duplicados', r.exit === 0 && ps.filter((p) => p.source === 'stt').length === 1 && (await jobOf(ing.caseId)).status === 'completed', `${pathsOf(r.log)} ${ps.map((p) => p.source + p.version)}`);
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, {}, { match: '/hitl-requests$', status: 503, mode: 'after' });
    const hs = await hitlOf(ing.caseId);
    check('Respuesta perdida al crear la revisión: una sola pendiente', r.exit === 0 && hs.length === 1 && hs[0].status === 'pending', `${pathsOf(r.log)} ${hs.length}`);
  }
  { const { ing, r } = await ingestAndRun(voiceWav, {}, {}, { match: '/workflow-jobs/[^/]+/complete$', status: 503, mode: 'after' });
    check('Respuesta perdida al completar: el mismo cuerpo da 200', r.exit === 0 && (await jobOf(ing.caseId)).status === 'completed', pathsOf(r.log));
  }
  { await drain(); const ing = await ingestVoice(voiceWav);
    const r = await run('test04Open000001', { match: CLAIM_RE, status: 503, mode: 'after' });
    const job = await jobOf(ing.caseId);
    check('Respuesta de claim perdida: no se reintenta; el trabajo queda reclamado hasta vencer su lease', r.exit === 1 && job.status === 'claimed' && job.attempts === 1 && !has(r.log, '/documents') && pathsOf(r.log).split('claim').length === 2, `${job.status} ${job.attempts} ${pathsOf(r.log)}`);
    const again = await run('test04Open000001');
    check('Con el lease vigente otra ejecución no lo reclama (sin trabajo duplicado)', again.exit === 0 && (await jobOf(ing.caseId)).attempts === 1 && !has(again.log, '/documents'), pathsOf(again.log));
  }

  // ---------- 7. Una sola reclamación y solo voice.transcribe
  { await drain();
    const first = await ingestVoice(voiceWav);
    const second = await ingestVoice(voiceWav, { name: 'otra.wav' });
    const doc = (await q(`SELECT id FROM documents LIMIT 1`))[0];
    const pdf = new FormData();
    pdf.append('file', new File([readFileSync(join(REPO, 'n8n/test-data/factura-ficticia-positiva.pdf'))], 'f.pdf', { type: 'application/pdf' }));
    pdf.append('requestId', randomUUID());
    const up = await (await fetch(`${API}/ingestions/documents`, { method: 'POST', headers: { Authorization: `Bearer ${daniel.jwt}` }, body: pdf })).json();
    const r = await run('test04Open000001');
    const j1 = await jobOf(first.caseId); const j2 = await jobOf(second.caseId); const jp = await jobOf(up.caseId, 'document.process');
    check('Una reclamación por ejecución: solo el trabajo de voz más antiguo', j1.attempts === 1 && j2.attempts === 0 && j2.status === 'pending', `${j1.attempts} ${j2.attempts}`);
    check('Los trabajos document.process y los demás de voz no se tocan', jp.status === 'pending' && jp.attempts === 0);
    const claimBody = r.log.find((e) => e.path.endsWith('/claim')).sent;
    check('La reclamación pide limit 1 y solo voice.transcribe', claimBody.limit === 1 && JSON.stringify(claimBody.jobTypes) === '["voice.transcribe"]', JSON.stringify(claimBody));
  }

  // ---------- 8. Idempotencia del ingreso (mismo requestId) y agotamiento de intentos
  { await drain();
    const rid = randomUUID();
    const a = await ingestVoice(voiceWav, { requestId: rid }); const b = await ingestVoice(voiceWav, { requestId: rid });
    check('Mismo requestId: 201 y luego 200 con el mismo caso, un solo trabajo', a.status === 201 && b.status === 200 && a.caseId === b.caseId && Number((await q(`SELECT count(*) AS n FROM workflow_jobs WHERE case_id = $1`, [a.caseId]))[0].n) === 1);
    const other = await ingestVoice(toneWav, { requestId: rid, name: 'tono.wav' });
    check('Mismo requestId con otro archivo: 409', other.status === 409);
  }
  { await drain(); const ing = await ingestVoice(voiceWav);
    for (let i = 1; i <= 5; i += 1) {
      await readyAgain(ing.caseId);
      const r = await run('test04Open000001', null, { sttRaw: 'no es JSON' });
      const job = await jobOf(ing.caseId);
      if (i < 5) { if (job.status !== 'pending' || job.attempts !== i) throw new Error(`intento ${i}: ${job.status} ${job.attempts}`); } else {
        check('Agotamiento: al 5.º intento fallido el trabajo queda failed y el caso failed', job.status === 'failed' && job.attempts === 5 && (await caseOf(ing.caseId)).status === 'failed', `${job.status} ${job.attempts} ${r.exit}`);
      }
    }
    await readyAgain(ing.caseId);
    const after = await run('test04Open000001');
    check('Tras agotar intentos nadie lo vuelve a reclamar', !has(after.log, '/documents') && (await jobOf(ing.caseId)).attempts === 5);
  }

  // ---------- 9. Formatos del backend y tamaño
  for (const [fmtName, file, mime, name, expected] of [
    ['mp3', fmt.mp3, 'audio/mpeg', 'a.mp3', 'audio/mp3'],
    ['ogg', fmt.ogg, 'audio/ogg', 'a.ogg', 'audio/ogg'],
    ['webm', fmt.webm, 'audio/webm', 'a.webm', 'audio/webm'],
    ['m4a', fmt.m4a, 'audio/mp4', 'a.m4a', 'audio/m4a'],
  ]) {
    await drain();
    const ing = await ingestVoice(file, { mime, name });
    if (ing.status !== 201) { check(`Formato ${fmtName}: el backend lo acepta`, false, `${ing.status} ${JSON.stringify(ing).slice(0, 120)}`); continue; }
    const r = await run('test04Open000001');
    check(`Formato ${fmtName}: backend ${ing.mimeType} → Gemini ${expected}`, r.exit === 0 && real(r.log)[0].mime === expected && real(r.log)[0].audioSha === ing.sha, `${r.exit} ${real(r.log)[0]?.mime}`);
  }
  { await drain();
    const ing = await ingestVoice(fmt.big, { name: 'grande.wav' });
    const r = await run('test04Open000001');
    const job = await jobOf(ing.caseId);
    check('Audio de 15 MiB: se rechaza de forma explícita, sin descargarlo ni llamar a Gemini', ing.status === 201 && r.exit === 1 && job.status === 'failed' && /límite del envío directo/.test(job.last_error) && !has(r.log, '/documents') && real(r.log).length === 0, `${ing.status} ${job.status} ${job.last_error}`);
  }

  // ---------- 10. Separación de usuarios
  { await drain();
    const danielBefore = await q(`SELECT count(*) AS n FROM obligations WHERE owner_id = $1`, [daniel.profileId]);
    const ing = await ingestVoice(voiceWav, { u: ana });
    const r = await run('test04Open000001');
    const [h] = await hitlOf(ing.caseId); const ps = await proposalsOf(ing.caseId);
    check('Ana: el caso, la propuesta y la revisión son de Ana', r.exit === 0 && (await caseOf(ing.caseId)).owner_id === ana.profileId && h.status === 'pending');
    check('Daniel no puede ver el caso de Ana', (await user('GET', `/cases/${ing.caseId}`)).status === 404);
    check('Daniel no puede decidir ni aplicar lo de Ana', [403, 404].includes((await decide(h.id, 'approved')).status) && [403, 404].includes((await apply(ing.caseId, ps[1].id)).status));
    await decide(h.id, 'approved', ana);
    const ap = await apply(ing.caseId, ps[1].id, ana);
    const [ob] = await q(`SELECT owner_id FROM obligations WHERE id = $1`, [ap.body.resource.obligationId]);
    check('La obligación creada es de Ana y Daniel no recibe ninguna', ap.status === 201 && ob.owner_id === ana.profileId && Number((await q(`SELECT count(*) AS n FROM obligations WHERE owner_id = $1`, [daniel.profileId]))[0].n) === Number(danielBefore[0].n));
    await run('test03Open000001');
  }

  // ---------- 11. Regresiones: workflows 03 ya probados siguen igual (el contrato no cambió)
  // Etapa 7 modifica a propósito los workflows 02-04 (ruta programada y verificaciones); el 01 sigue intacto.
  { const status = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'n8n/workflows/01-prueba-de-conexion.json'], { encoding: 'utf8' });
    // El backend sí puede cambiar: esta suite lo ejercita de verdad. Lo que debe cumplirse es que
    // lo probado sea el compilado de las fuentes actuales, no uno anterior.
    const newest = (dir, re) => Math.max(0, ...readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && re.test(e.name)).map((e) => statSync(join(e.parentPath, e.name)).mtimeMs));
    const srcTime = newest(join(BACKEND, 'src'), /\.ts$/);
    const distTime = newest(join(BACKEND, 'dist'), /\.js$/);
    check('Workflow 01 sin cambios, y el backend probado es el compilado de las fuentes actuales', status.status === 0 && status.stdout.trim() === '' && distTime >= srcTime, `${status.stdout} src=${new Date(srcTime).toISOString()} dist=${new Date(distTime).toISOString()}`);
  }
} catch (e) {
  failed += 1;
  console.log(`ERR excepción: ${e.stack}`);
} finally {
  console.log(failed ? `FALLARON ${failed} de ${total}` : `Todo correcto: ${total} comprobaciones`);
  await cleanup();
}
process.exitCode = failed ? 1 : 0;
process.exit();
