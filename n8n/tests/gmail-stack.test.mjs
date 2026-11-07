/**
 * Banco de pruebas 100 % local del workflow 05 con el BACKEND REAL compilado:
 * PostgreSQL 18 desechable + `node dist/main` + n8n desechable + un proxy con
 * Gmail, Gemini y el servidor de tokens simulados, y fallos inyectados. No lee
 * backend/.env y exige que la base de datos sea local. No puede llamar a Google:
 * sus dominios apuntan a 127.0.0.1 dentro del contenedor de n8n.
 *
 * Requisitos: Docker y `npm run build` en backend/.
 * Uso: node n8n/tests/gmail-stack.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BACKEND = join(REPO, 'backend');
const require = createRequire(`${BACKEND}/`);
const pg = require('pg');

const PG_PORT = 55438;
const API_PORT = 3998;
const PROXY_PORT = 18768;
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const REMOTE = `http://host.docker.internal:${PROXY_PORT}`;
const PG_NAME = 'notihouse-gmail-pg';
const N8N_NAME = 'notihouse-gmail-n8n';
const IMAGE = 'docker.n8n.io/n8nio/n8n:2.46.6';
const MAILBOX = 'buzon-demo@notihouse.test';
const OTHER_MAILBOX = 'sin-vinculo@notihouse.test';
const SENDER = 'facturacion@proveedor.test';
const MAX_BACKEND_PDF = 64 * 1024;
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

const pgPassword = randomBytes(18).toString('base64url');
const serviceToken = randomBytes(48).toString('base64url');
const jwtSecret = randomBytes(48).toString('base64url');
const FAKE_ACCESS_TOKEN = `fake-${randomBytes(12).toString('hex')}`;
const DATABASE_URL = `postgresql://postgres:${pgPassword}@127.0.0.1:${PG_PORT}/notihouse`;
if (!/@127\.0\.0\.1:/.test(DATABASE_URL)) throw new Error('Destino no local');

const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = mkdtempSync(join(tmpdir(), 'notihouse-gmail-'));
const WORK = join(ROOT, 'work');
mkdirSync(WORK, { recursive: true });

let db; let apiProcess; let proxyServer;
function cleanup() {
  try { db?.end(); } catch { /* ya cerrada */ }
  apiProcess?.kill();
  proxyServer?.close();
  docker('rm', '-f', N8N_NAME);
  docker('rm', '-f', PG_NAME);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* el sistema limpia el temporal */ }
}

// ---------------------------------------------------- PostgreSQL desechable y migraciones
docker('rm', '-f', PG_NAME);
const started = docker('run', '-d', '--rm', '--name', PG_NAME, '-p', `127.0.0.1:${PG_PORT}:5432`, '--tmpfs', '/var/lib/postgresql', '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', 'POSTGRES_DB=notihouse', 'postgres:18');
if (started.status !== 0) throw new Error(started.stderr);
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

// ---------------------------------------------------- Usuarios (antes de la API, que lee el vínculo al arrancar)
const { hashPassword } = await import(pathToFileURL(join(BACKEND, 'dist/auth/password.js')));
async function makeUser(name) {
  const email = `${name}@notihouse.test`;
  const password = randomBytes(12).toString('base64url');
  const [{ id: profileId }] = await q('INSERT INTO profiles (display_name) VALUES ($1) RETURNING id', [name]);
  await q('INSERT INTO auth_accounts (profile_id, email, password_hash) VALUES ($1, $2, $3)', [profileId, email, await hashPassword(password)]);
  return { profileId, email, password };
}
const daniel = await makeUser('daniel-local');
const ana = await makeUser('ana-local');

// ---------------------------------------------------- Backend real (solo con el entorno de esta prueba)
apiProcess = spawn('node', ['--no-warnings', join(BACKEND, 'dist/main.js')], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'development', PORT: String(API_PORT), DATABASE_URL, JWT_SECRET: jwtSecret, N8N_SERVICE_TOKEN: serviceToken,
    STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: join(ROOT, 'storage'), STORAGE_UPLOAD_TMP_PATH: join(ROOT, 'tmp'),
    STORAGE_MAX_PDF_BYTES: String(MAX_BACKEND_PDF),
    GMAIL_MAILBOX_LINKS: `${MAILBOX}=${daniel.profileId}`,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let apiErr = '';
apiProcess.stderr.on('data', (d) => { apiErr += d; });
for (let i = 0; ; i += 1) {
  const r = await fetch(`${API}/health/ready`).catch(() => null);
  if (r?.status === 200) break;
  if (i > 40) { console.log(apiErr.slice(-800)); cleanup(); throw new Error('La API local no arrancó'); }
  await sleep(1000);
}
const login = async (u) => {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }) });
  if (res.status !== 200) throw new Error(`login ${res.status}`);
  return (await res.json()).accessToken;
};
daniel.jwt = await login(daniel);
ana.jwt = await login(ana);
const api = async (method, path, token, body) => {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ---------------------------------------------------- Archivos ficticios
const pdf = (text = randomUUID()) => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const realInvoice = readFileSync(join(REPO, 'n8n/test-data/factura-ficticia-positiva.pdf'));

// ---------------------------------------------------- Gmail y Gemini simulados, y proxy con fallos
let mail = []; let profileAddress = MAILBOX; let log = []; let faults = [];
const issued = new Map();
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Como en Gmail: el attachmentId cambia en cada lectura; el partId no. */
function renderPart(part, partId, msgId) {
  const { filename = '', mimeType = 'text/plain', bytes, declaredSize, parts, noAttachmentId } = part;
  const body = { size: declaredSize ?? bytes?.length ?? 0 };
  if (bytes && !noAttachmentId) {
    const aid = `ANG-${randomBytes(16).toString('hex')}`;
    issued.set(`${msgId}/${aid}`, bytes);
    body.attachmentId = aid;
  }
  return { partId, mimeType, filename, body, ...(parts ? { parts: parts.map((p, i) => renderPart(p, `${partId === '' ? '' : `${partId}.`}${i}`, msgId)) } : {}) };
}
const message = (id, parts, { from = `Proveedor <${SENDER}>`, subject = 'Factura ficticia' } = {}) => ({ id, from, subject, parts });
const POSITIVE = JSON.stringify({ isInvoice: true, providerName: 'Servicios Ficticios de Prueba S.A.S.', concept: 'Internet hogar de demostracion', category: 'internet', periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-10', amount: '98500.00', currency: 'COP', evidence: [{ field: 'amount', text: 'Total a pagar: 98.500,00 COP' }] });
const PREFLIGHT = JSON.stringify({ isInvoice: true, providerName: 'Empresa Ficticia de Comprobacion S.A.S.', concept: 'Acueducto de demostracion', category: 'water', periodStart: '2026-10-01', periodEnd: '2026-10-31', dueDate: '2026-11-15', amount: '45250.50', currency: 'COP', evidence: [] });

const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
proxyServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? '', status: 0 };
    log.push(entry);
    const fault = faults.find((f) => f.times > 0 && f.match.test(url.pathname) && (!f.method || f.method === req.method));
    if (fault && fault.mode !== 'lost') {
      fault.times -= 1;
      entry.status = fault.status;
      return json(res, fault.status, { error: { code: fault.status, message: 'fallo inyectado' } });
    }
    if (url.pathname.includes(':generateContent')) {
      entry.status = 200;
      const text = body.toString();
      return json(res, 200, { modelVersion: 'simulado', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: text.includes('Empresa Ficticia de Comprobacion') ? PREFLIGHT : POSITIVE }] } }] });
    }
    if (url.pathname.startsWith('/gmail/')) {
      entry.status = 200;
      const seg = url.pathname.split('/').filter(Boolean);
      if (req.method !== 'GET') { entry.status = 405; return json(res, 405, {}); }
      if (url.pathname.endsWith('/profile')) return json(res, 200, { emailAddress: profileAddress });
      if (url.pathname.endsWith('/messages')) return json(res, 200, { ...(mail.length ? { messages: mail.map((m) => ({ id: m.id })) } : {}), ...(mail.more ? { nextPageToken: 'mas' } : {}) });
      if (seg.includes('attachments')) {
        const bytes = issued.get(`${seg[5]}/${seg[7]}`);
        if (!bytes) { entry.status = 404; return json(res, 404, {}); }
        return json(res, 200, { size: bytes.length, data: b64url(bytes) });
      }
      const m = mail.find((x) => x.id === seg[5]);
      if (!m) { entry.status = 404; return json(res, 404, {}); }
      return json(res, 200, {
        id: m.id, internalDate: String(Date.parse('2026-11-05T12:00:00Z')),
        payload: { partId: '', mimeType: 'multipart/mixed', filename: '', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], body: { size: 0 }, parts: m.parts.map((p, i) => renderPart(p, String(i), m.id)) },
      });
    }
    // Backend real
    const out = httpRequest({ host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` } }, (upstream) => {
      entry.status = upstream.statusCode;
      if (fault?.mode === 'lost') {
        fault.times -= 1;
        upstream.resume();
        upstream.on('end', () => res.destroy());
        return;
      }
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    out.on('error', () => res.destroy());
    out.end(body);
    return undefined;
  });
});
await new Promise((r) => proxyServer.listen(PROXY_PORT, '127.0.0.1', r));

// ---------------------------------------------------- n8n desechable con el workflow real y solo su configuración cambiada
const wfPath = join(REPO, 'n8n/workflows/05-recepcion-gmail.json');
const repoWorkflow = JSON.parse(readFileSync(wfPath, 'utf8'));
const variant = (id, { read = false, ingest = false, mailbox = MAILBOX, senders = [SENDER], cred = null } = {}) => {
  const w = JSON.parse(JSON.stringify(repoWorkflow));
  const config = w.nodes.find((n) => n.name === 'Configuracion');
  const code = config.parameters.jsCode
    .replace('https://notihouse-pal-api.onrender.com/api/v1', `${REMOTE}/api/v1`)
    .replace('https://gmail.googleapis.com', REMOTE)
    .replace('AUTORIZAR_LECTURA_GMAIL = false', `AUTORIZAR_LECTURA_GMAIL = ${read}`)
    .replace('AUTORIZAR_INGESTA = false', `AUTORIZAR_INGESTA = ${ingest}`)
    .replace("BUZON_AUTORIZADO = ''", `BUZON_AUTORIZADO = '${mailbox}'`)
    .replace('REMITENTES_AUTORIZADOS = []', `REMITENTES_AUTORIZADOS = ${JSON.stringify(senders)}`);
  config.parameters.jsCode = code;
  if (cred) for (const n of w.nodes) if (n.credentials?.httpHeaderAuth) n.credentials.httpHeaderAuth = cred;
  w.id = id; w.name = id;
  writeFileSync(join(WORK, `${id}.json`), JSON.stringify(w));
  return id;
};
const other = (file, id) => {
  const w = JSON.parse(readFileSync(join(REPO, 'n8n/workflows', file), 'utf8'));
  const config = w.nodes.find((n) => n.name === 'Configuracion');
  config.parameters.jsCode = config.parameters.jsCode
    .replace('https://notihouse-pal-api.onrender.com/api/v1', `${REMOTE}/api/v1`)
    .replace('https://generativelanguage.googleapis.com', REMOTE)
    .replace('AUTORIZAR_RECLAMACION = false', 'AUTORIZAR_RECLAMACION = true');
  w.id = id; w.name = id;
  writeFileSync(join(WORK, `${id}.json`), JSON.stringify(w));
  return id;
};
const WF = {
  closed: variant('test05Closed0001'),
  empty: variant('test05Empty00001', { read: true, ingest: true, mailbox: '', senders: [] }),
  review: variant('test05Review0001', { read: true }),
  open: variant('test05Open000001', { read: true, ingest: true }),
  unlinked: variant('test05Unlink0001', { read: true, ingest: true, mailbox: OTHER_MAILBOX }),
  badToken: variant('test05BadToken01', { read: true, ingest: true, cred: { id: 'badService000001', name: 'Token incorrecto' } }),
  doc: other('02-procesamiento-documental.json', 'test02Open000001'),
  close: other('03-cierre-hitl.json', 'test03Open000001'),
};
writeFileSync(join(WORK, 'creds.json'), JSON.stringify([
  { id: 'nhpApiService001', name: 'NotiHouse-Pal API (servicio)', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${serviceToken}` } },
  { id: 'badService000001', name: 'Token incorrecto', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${randomBytes(48).toString('base64url')}` } },
  { id: 'V3F6GYNAb2ExkptK', name: 'Google Gemini(PaLM) Api account', type: 'googlePalmApi', data: { host: REMOTE, apiKey: 'clave-falsa' } },
  { id: 'nhpGmailRead0001', name: 'NotiHouse Gmail', type: 'googleOAuth2Api', data: { clientId: 'falso', clientSecret: 'falso', scope: READONLY, oauthTokenData: { access_token: FAKE_ACCESS_TOKEN, refresh_token: 'falso', token_type: 'Bearer', expires_in: 3600, scope: READONLY } } },
]));
docker('rm', '-f', N8N_NAME);
docker('run', '-d', '--name', N8N_NAME, '--add-host', 'host.docker.internal:host-gateway', '-e', 'NODE_TLS_REJECT_UNAUTHORIZED=0', ...['accounts.google.com', 'oauth2.googleapis.com', 'gmail.googleapis.com', 'generativelanguage.googleapis.com'].flatMap((h) => ['--add-host', `${h}:127.0.0.1`]), '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-v', `${WORK.replace(/\\/g, '/')}:/work:ro`, '--entrypoint', 'sh', IMAGE, '-c', 'sleep 7200');
const inside = (cmd) => docker('exec', N8N_NAME, 'sh', '-c', cmd);
inside('n8n import:credentials --input=/work/creds.json 2>&1 | tail -1');
for (const id of Object.values(WF)) inside(`n8n import:workflow --input=/work/${id}.json 2>&1 | tail -1`);
writeFileSync(join(WORK, 'creds.json'), '[]');

writeFileSync(join(WORK, 'token-server.cjs'), `
const https = require('https'); const fs = require('fs');
https.createServer({ key: fs.readFileSync('/work/k.pem'), cert: fs.readFileSync('/work/c.pem') }, (req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    fs.appendFileSync('/tmp/token.log', JSON.stringify({ path: req.url, form, auth: Boolean(req.headers.authorization) }) + '\\n');
    const revoked = fs.existsSync('/tmp/token-revoked');
    res.writeHead(revoked ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(revoked ? { error: 'invalid_grant' } : { access_token: 'renovado-' + Date.now(), token_type: 'Bearer', expires_in: 3599, scope: '${READONLY}' }));
  });
}).listen(443, '127.0.0.1');
`);
// Certificado de un solo uso (la imagen de n8n no trae openssl; la de PostgreSQL sí).
const cert = docker('run', '--rm', '--entrypoint', 'sh', '-v', `${WORK.replace(/\\/g, '/')}:/w`, 'postgres:18', '-c', 'openssl req -x509 -newkey rsa:2048 -nodes -keyout /w/k.pem -out /w/c.pem -days 1 -subj /CN=oauth2.googleapis.com 2>/dev/null; chmod 644 /w/k.pem; test -s /w/c.pem && echo CERT_OK');
if (!cert.stdout.includes('CERT_OK')) { cleanup(); throw new Error(`Sin certificado de prueba: ${cert.stderr}`); }
docker('exec', '-d', N8N_NAME, 'node', '/work/token-server.cjs');
await sleep(1000);
const tokenRequests = () => inside('cat /tmp/token.log 2>/dev/null; true').stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const clearTokenLog = () => inside('rm -f /tmp/token.log');
const setRevoked = (on) => inside(on ? 'touch /tmp/token-revoked' : 'rm -f /tmp/token-revoked');

const run = async (id, { faults: f = [] } = {}) => {
  log = [];
  faults = f.map((x) => ({ times: 1, ...x }));
  const out = await new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', N8N_NAME, 'sh', '-c', `n8n execute --id ${id} --rawOutput > /tmp/o.txt 2>&1; echo EXIT=$?; cat /tmp/o.txt`]);
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });
  faults = [];
  const summary = /"Resumen": \[[\s\S]*?"conteo": (\{[^}]*\})/.exec(out)?.[1];
  return { exit: Number(/EXIT=(\d+)/.exec(out)?.[1] ?? -1), out, log: [...log], conteo: summary ? JSON.parse(summary) : null };
};
const gmailCalls = (l) => l.filter((e) => e.path.startsWith('/gmail/'));
const backendWrites = (l) => l.filter((e) => e.path.startsWith('/api/') && e.method !== 'GET');
const downloads = (l) => l.filter((e) => e.path.includes('/attachments/') && e.path.startsWith('/gmail/'));
const counts = async () => (await q(`SELECT (SELECT count(*)::int FROM documents) AS documents, (SELECT count(*)::int FROM cases) AS cases, (SELECT count(*)::int FROM workflow_jobs) AS jobs, (SELECT count(*)::int FROM obligations) AS obligations, (SELECT count(*)::int FROM case_proposals) AS proposals, (SELECT count(*)::int FROM hitl_requests) AS hitl`))[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const delta = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]));
/** Deja la cola de document.process vacía para las pruebas del workflow 02. */
const docByMessage = async (id) => q(`SELECT d.id, d.owner_id, d.source, d.file_name, d.external_message_id, d.sha256, d.case_id, c.status AS case_status, c.source AS case_source, c.owner_id AS case_owner FROM documents d JOIN cases c ON c.id = d.case_id WHERE d.external_message_id = $1 ORDER BY d.created_at`, [`gmail:${id}`]);

let failed = 0; let total = 0;
const check = (name, ok, detail = '') => {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK ' : 'ERR'} ${name}${detail !== '' && !ok ? ` | ${String(detail).slice(0, 400)}` : ''}`);
};

async function refreshChecks() {
  // ---------- Token caducado: la credencial de solo lectura se renueva en cada nodo de Gmail
  {
    const box = (id) => [message(id, [{ filename: `${id}.pdf`, mimeType: 'application/pdf', bytes: pdf(id) }])];
    for (const [label, id, match] of [
      ['Perfil de Gmail', 'm-r1', /\/profile$/],
      ['Listar mensajes', 'm-r2', /\/messages$/],
      ['Leer mensaje', 'm-r3', /\/messages\/m-r3$/],
      ['Descargar adjunto', 'm-r4', /\/m-r4\/attachments\//],
    ]) {
      mail = box(id);
      await clearTokenLog();
      const r = await run(WF.open, { faults: [{ match, status: 401 }] });
      const refresh = tokenRequests();
      if (process.env.GMAIL_TEST_DUMP) writeFileSync(`${process.env.GMAIL_TEST_DUMP}-${id}.txt`, `${JSON.stringify(r.log.map((e) => [e.method, e.path, e.status, e.auth.slice(0, 18)]))}\n${r.out}`);
      check(`401 en "${label}": renueva el token y continúa`, r.exit === 0 && r.conteo?.registrado === 1 && refresh.length === 1, `exit=${r.exit} ${JSON.stringify(r.conteo)} renovaciones=${refresh.length} ${/"message": "([^"]{0,200})/.exec(r.out)?.[1] ?? ''}`);
      const renewed = gmailCalls(r.log).filter((e) => e.status === 200);
      check(`Renovación desde "${label}": grant refresh_token, sin ampliar permisos, y la solicitud se repite con el token nuevo`, refresh[0]?.path === '/token' && refresh[0]?.form?.grant_type === 'refresh_token' && (refresh[0]?.form?.scope === undefined || refresh[0].form.scope === READONLY) && renewed.at(-1)?.auth.startsWith('Bearer renovado-'), JSON.stringify({ path: refresh[0]?.path, grant: refresh[0]?.form?.grant_type, scope: refresh[0]?.form?.scope, auth: renewed.at(-1)?.auth.slice(0, 20) }));
    }
  }

}

try {
  if (process.env.GMAIL_TEST_ONLY === 'refresh') {
    await refreshChecks();
    throw new Error('solo el bloque de renovación');
  }
  // ---------- Seguridad estática del workflow
  {
    const raw = JSON.stringify(repoWorkflow);
    const config = repoWorkflow.nodes.find((n) => n.name === 'Configuracion').parameters.jsCode;
    check('Workflow versionado: ambos interruptores en false y sin buzón ni remitentes', /AUTORIZAR_LECTURA_GMAIL = false/.test(config) && /AUTORIZAR_INGESTA = false/.test(config) && /BUZON_AUTORIZADO = ''/.test(config) && /REMITENTES_AUTORIZADOS = \[\]/.test(config));
    check('Inactivo y sin triggers automáticos', repoWorkflow.active === false && repoWorkflow.nodes.filter((n) => /trigger|schedule|cron|webhook/i.test(n.type)).every((n) => n.type === 'n8n-nodes-base.manualTrigger'));
    check('Sin secretos en el JSON', !/AIza|ya29\.|Bearer\s+[A-Za-z0-9_-]{20,}|postgres(ql)?:\/\//.test(raw));
    check('Todo acceso a Gmail es GET y usa la credencial de solo lectura', repoWorkflow.nodes.filter((n) => n.credentials?.googleOAuth2Api).every((n) => n.parameters.method === 'GET'));
    check('No hay nodos de Gmail capaces de modificar el buzón', !repoWorkflow.nodes.some((n) => /gmail/i.test(n.type)) && !/\/modify|\/trash|\/send|\/batchModify|\/delete/.test(raw));
    check('No conserva datos de ejecución', repoWorkflow.settings.saveDataSuccessExecution === 'none' && repoWorkflow.settings.saveDataErrorExecution === 'none' && repoWorkflow.settings.saveManualExecutions === false);
    const fields = /messageFields: (.*)/.exec(config)?.[1] ?? '';
    check('Nunca pide el cuerpo del correo', /attachmentId,size/.test(config) && !/body\(data/.test(config) && fields.length > 0);
  }

  // ---------- Interruptores
  {
    mail = [message('m-closed', [{ filename: 'f.pdf', mimeType: 'application/pdf', bytes: pdf() }])];
    const before = await counts();
    const r = await run(WF.closed);
    check('Interruptores en false: ni Google ni backend', r.exit === 0 && r.log.length === 0 && same(before, await counts()), JSON.stringify(r.log));
    const e = await run(WF.empty);
    check('Sin buzón ni remitentes configurados: se detiene antes de llamar a Google', e.exit === 1 && e.log.length === 0 && /BUZON_AUTORIZADO/.test(e.out), e.out.slice(0, 300));
  }

  // ---------- Modo revisión (lo previo a pedir autorización)
  {
    mail = [message('m-review', [{ mimeType: 'text/plain' }, { filename: 'factura.pdf', mimeType: 'application/pdf', bytes: pdf() }], { subject: 'Asunto visible' })];
    const before = await counts();
    const r = await run(WF.review);
    check('Revisión: lista mensaje y adjunto sin descargar nada ni escribir', r.exit === 0 && downloads(r.log).length === 0 && backendWrites(r.log).length === 0 && same(before, await counts()) && r.conteo?.pendiente_de_autorizacion === 1, r.out.slice(-500));
    check('Revisión: muestra asunto, remitente, nombre y parte', /Asunto visible/.test(r.out) && /factura\.pdf/.test(r.out) && r.out.includes(SENDER));
    const list = r.log.find((e) => e.path.endsWith('/messages'));
    check('Consulta acotada: etiqueta, adjunto PDF, remitente y antigüedad', /^label:notihouse-facturas-prueba has:attachment filename:pdf newer_than:30d from:\(/.test(list?.query.q ?? '') && list.query.q.includes(SENDER) && list.query.maxResults === '5', list?.query.q);
    const get = r.log.find((e) => e.path.endsWith('/m-review'));
    check('Lectura del mensaje: el campo fields excluye el cuerpo', /body\(attachmentId,size\)/.test(get?.query.fields ?? '') && !/\bdata\b/.test(get?.query.fields ?? ''), get?.query.fields);
    check('Usa la credencial OAuth simulada en cada llamada', gmailCalls(r.log).every((e) => e.auth === `Bearer ${FAKE_ACCESS_TOKEN}`));
  }

  // ---------- Buzón
  {
    profileAddress = 'otra.cuenta@notihouse.test';
    mail = [message('m-wrong', [{ filename: 'f.pdf', mimeType: 'application/pdf', bytes: pdf() }])];
    const r = await run(WF.open);
    profileAddress = MAILBOX;
    check('La credencial pertenece a otra cuenta: se detiene antes de listar', r.exit === 1 && gmailCalls(r.log).length === 1 && gmailCalls(r.log)[0].path.endsWith('/profile') && /no corresponde al buzón/.test(r.out), JSON.stringify(gmailCalls(r.log)));
    profileAddress = OTHER_MAILBOX;
    const before = await counts();
    const u = await run(WF.unlinked);
    profileAddress = MAILBOX;
    check('Buzón sin vínculo en el backend: 403, sin registrar nada', u.exit === 1 && u.conteo === null && /buzon_no_vinculado=1/.test(u.out) && same(before, await counts()), u.out.slice(-400));
  }

  // ---------- Mensaje autorizado con un PDF válido, y repetición
  let firstDoc;
  {
    mail = [message('m-valid', [{ mimeType: 'text/plain' }, { filename: 'Factura Noviembre.PDF', mimeType: 'application/pdf', bytes: pdf('valida') }])];
    const before = await counts();
    const r = await run(WF.open);
    const [doc] = await docByMessage('m-valid');
    firstDoc = doc;
    check('PDF válido: registrado', r.exit === 0 && r.conteo?.registrado === 1, r.out.slice(-500));
    check('Documento y caso con origen gmail, del propietario del vínculo', doc?.source === 'gmail' && doc.case_source === 'gmail' && doc.owner_id === daniel.profileId && doc.case_owner === daniel.profileId && doc.case_status === 'received', JSON.stringify(doc));
    check('Crea exactamente documento, caso y trabajo; ninguna obligación, propuesta ni revisión', same(delta(before, await counts()), { documents: 1, cases: 1, jobs: 1, obligations: 0, proposals: 0, hitl: 0 }));
    const [job] = await q('SELECT job_type, status, attempts, idempotency_key FROM workflow_jobs WHERE case_id = $1', [doc.case_id]);
    check('Trabajo document.process pendiente, con clave buzón + mensaje + parte', job.job_type === 'document.process' && job.status === 'pending' && job.attempts === 0 && /^gmail:[0-9a-f]{32}:m-valid:1$/.test(job.idempotency_key), JSON.stringify(job));
    check('El buzón no queda en claro en la clave', !job.idempotency_key.includes('notihouse'));
    const audit = await q(`SELECT a.action, a.actor_type, a.actor_id, a.metadata::text AS m FROM audit_events a JOIN cases c ON c.correlation_id = a.correlation_id WHERE c.id = $1`, [doc.case_id]);
    check('Auditoría: creación completa con actor workflow, sin buzón, remitente ni asunto', audit.length === 3 && audit.every((e) => e.actor_type === 'workflow' && e.actor_id === 'n8n:gmail-intake') && audit.every((e) => !/notihouse\.test|proveedor\.test|Factura ficticia/.test(e.m)), JSON.stringify(audit));
    const stored = await fetch(`${API}/documents/${doc.id}/content`, { headers: { Authorization: `Bearer ${daniel.jwt}` } });
    check('Los bytes guardados son los del adjunto', stored.status === 200 && Buffer.from(await stored.arrayBuffer()).equals(pdf('valida')));
    check('Aislamiento: Ana no ve el documento ni el caso', (await api('GET', `/documents/${doc.id}`, ana.jwt)).status === 404 && (await api('GET', `/cases/${doc.case_id}`, ana.jwt)).status === 404);
    const again = await run(WF.open);
    const sameAid = again.log.filter((e) => e.path.includes('/attachments/'))[0]?.path;
    check('Repetir el mismo correo: ya_registrado, aunque Gmail cambie el attachmentId', again.exit === 0 && again.conteo?.ya_registrado === 1 && !again.conteo?.registrado && Boolean(sameAid) && sameAid !== r.log.filter((e) => e.path.includes('/attachments/'))[0]?.path, again.out.slice(-500));
    check('La repetición no crea nada', same(delta(before, await counts()), { documents: 1, cases: 1, jobs: 1, obligations: 0, proposals: 0, hitl: 0 }));
    check('Solo llamadas GET a Gmail, nunca escritura en el buzón', gmailCalls([...r.log, ...again.log]).every((e) => e.method === 'GET'));
  }

  // ---------- Correo nuevo con archivo idéntico
  {
    mail = [message('m-copy', [{ filename: 'otra-copia.pdf', mimeType: 'application/pdf', bytes: pdf('valida') }])];
    const r = await run(WF.open);
    const [doc] = await docByMessage('m-copy');
    check('Correo nuevo con archivo idéntico: caso nuevo, señalado como contenido duplicado', r.exit === 0 && r.conteo?.registrado === 1 && doc.case_id !== firstDoc.case_id && doc.sha256 === firstDoc.sha256 && /"duplicateContent": true/.test(r.out), r.out.slice(-400));
  }

  // ---------- Casos sin ingesta
  {
    const before = await counts();
    mail = [message('m-none', [{ mimeType: 'text/plain' }])];
    const none = await run(WF.open);
    check('Mensaje sin adjuntos: se informa y no descarga nada', none.exit === 0 && none.conteo?.sin_adjuntos === 1 && downloads(none.log).length === 0, none.out.slice(-300));
    mail = [message('m-type', [{ filename: 'factura.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from('x') }, { filename: 'virus.exe', mimeType: 'application/pdf', bytes: Buffer.from('MZ') }, { filename: 'falso.pdf', mimeType: 'application/octet-stream', bytes: pdf() }])];
    const type = await run(WF.open);
    check('Adjuntos no admitidos: rechazados sin descargarlos', type.exit === 0 && type.conteo?.tipo_no_admitido === 3 && downloads(type.log).length === 0, type.out.slice(-300));
    mail = [message('m-big', [{ filename: 'enorme.pdf', mimeType: 'application/pdf', bytes: pdf(), declaredSize: 11 * 1024 * 1024 }])];
    const big = await run(WF.open);
    check('Adjunto mayor que el máximo: no se descarga', big.exit === 0 && big.conteo?.demasiado_grande === 1 && downloads(big.log).length === 0, big.out.slice(-300));
    mail = [message('m-nested', [{ filename: 'reenviado.eml', mimeType: 'message/rfc822', parts: [{ filename: 'dentro.pdf', mimeType: 'application/pdf', bytes: pdf() }] }])];
    const nested = await run(WF.open);
    check('PDF dentro de un correo reenviado: fuera de alcance', nested.exit === 0 && nested.conteo?.tipo_no_admitido === 1 && downloads(nested.log).length === 0, nested.out.slice(-300));
    mail = [message('m-spoof', [{ filename: 'f.pdf', mimeType: 'application/pdf', bytes: pdf() }], { from: 'Otro <otro@ajeno.test>' })];
    const spoof = await run(WF.open);
    check('Remitente no autorizado (aunque pase la consulta): no se descarga ni se muestra', spoof.exit === 0 && spoof.conteo?.remitente_no_autorizado === 1 && downloads(spoof.log).length === 0 && !spoof.out.split('"Resumen"')[1]?.includes('otro@ajeno.test'), spoof.out.slice(-300));
    mail = [message('m-inline', [{ filename: 'sinid.pdf', mimeType: 'application/pdf', bytes: pdf(), noAttachmentId: true }])];
    const inline = await run(WF.open);
    check('Parte sin identificador de adjunto: se informa, no falla', inline.exit === 0 && inline.conteo?.sin_identificador === 1, inline.out.slice(-300));
    mail = [];
    const empty = await run(WF.open);
    check('Sin mensajes: termina sin escribir', empty.exit === 0 && backendWrites(empty.log).length === 0 && !empty.conteo);
    check('Ninguno de estos casos creó registros', same(before, await counts()));
  }

  // ---------- El backend sigue siendo quien valida el contenido
  {
    const before = await counts();
    mail = [message('m-fake', [{ filename: 'engaño.pdf', mimeType: 'application/pdf', bytes: Buffer.from('MZ esto no es un PDF, aunque lo declare') }])];
    const fake = await run(WF.open);
    check('Extensión engañosa: el backend responde 415; rechazo definitivo, sin error de ejecución', fake.exit === 0 && fake.conteo?.rechazado === 1 && /"httpStatus": 415/.test(fake.out), fake.out.slice(-400));
    mail = [message('m-large', [{ filename: 'grande.pdf', mimeType: 'application/pdf', bytes: Buffer.concat([pdf(), Buffer.alloc(MAX_BACKEND_PDF + 1024, 0x20)]) }])];
    const large = await run(WF.open);
    check('PDF mayor que el límite del backend: 413, rechazo definitivo', large.exit === 0 && large.conteo?.rechazado === 1 && /"httpStatus": 413/.test(large.out), large.out.slice(-400));
    check('Los rechazos no crean registros', same(before, await counts()));
  }

  // ---------- Varios adjuntos
  {
    const before = await counts();
    mail = [message('m-multi', [{ mimeType: 'text/plain' }, { filename: 'a.pdf', mimeType: 'application/pdf', bytes: pdf('multi-a') }, { filename: 'foto.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('x') }, { filename: 'b.pdf', mimeType: 'application/pdf', bytes: pdf('multi-b') }])];
    const r = await run(WF.open);
    const docs = await docByMessage('m-multi');
    check('Varios adjuntos: dos PDF registrados por separado y el resto rechazado', r.exit === 0 && r.conteo?.registrado === 2 && r.conteo?.tipo_no_admitido === 1 && docs.length === 2 && docs[0].case_id !== docs[1].case_id, r.out.slice(-400));
    check('Varios adjuntos: un documento, caso y trabajo por PDF', same(delta(before, await counts()), { documents: 2, cases: 2, jobs: 2, obligations: 0, proposals: 0, hitl: 0 }));
    const parts = (await q('SELECT idempotency_key FROM workflow_jobs j JOIN documents d ON d.case_id = j.case_id WHERE d.external_message_id = $1 ORDER BY 1', ['gmail:m-multi'])).map((x) => x.idempotency_key.split(':').pop());
    check('Varios adjuntos: cada clave lleva su parte', same(parts, ['1', '3']), parts.join());
    mail = [message('m-many', Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.pdf`, mimeType: 'application/pdf', bytes: pdf(`many-${i}`) })))];
    const many = await run(WF.open);
    check('Límite por mensaje: procesa 5 y señala el resto', many.exit === 0 && many.conteo?.registrado === 5 && many.conteo?.limite_de_adjuntos === 1, `exit=${many.exit} conteo=${JSON.stringify(many.conteo)} ${/"message": "([^"]{0,250})/.exec(many.out)?.[1] ?? ''} ${many.log.filter((e) => e.path.includes('/internal/gmail')).map((e) => e.status).join()}`);
  }

  // ---------- Fallos temporales de Gmail
  {
    const before = await counts();
    mail = [message('m-gm', [{ filename: 'gm.pdf', mimeType: 'application/pdf', bytes: pdf('gm') }])];
    const list = await run(WF.open, { faults: [{ match: /\/messages$/, status: 503, times: 5 }] });
    check('Gmail 503 persistente al listar: se detiene sin registrar nada y sin exponer detalles', list.exit === 1 && /Gmail no respondió/.test(list.out) && same(before, await counts()) && !backendWrites(list.log).length, list.out.slice(-300));
    const retry = await run(WF.open, { faults: [{ match: /\/messages$/, status: 503, times: 1 }] });
    check('Gmail 503 pasajero al listar: el reintento del nodo lo resuelve', retry.exit === 0 && retry.conteo?.registrado === 1, retry.out.slice(-300));
    const after = await counts();
    const quota = await run(WF.open, { faults: [{ match: /\/profile$/, status: 429, times: 5 }] });
    check('Gmail 429 persistente: mensaje claro, sin leer mensajes', quota.exit === 1 && /límite de Gmail \(429\)/.test(quota.out) && gmailCalls(quota.log).every((e) => e.path.endsWith('/profile')), quota.out.slice(-300));
    await setRevoked(true);
    const revoked = await run(WF.open, { faults: [{ match: /\/profile$/, status: 401, times: 20 }] });
    await setRevoked(false);
    check('Refresh token revocado o vencido: pide reconectar la credencial, sin leer mensajes ni registrar nada', revoked.exit === 1 && /debe reconectarse/.test(revoked.out) && gmailCalls(revoked.log).every((e) => e.path.endsWith('/profile')) && same(after, await counts()), revoked.out.slice(-400));
    const denied = await run(WF.open, { faults: [{ match: /\/profile$/, status: 401, times: 20 }] });
    check('401 persistente aun con token renovado: lo informa y no registra nada', denied.exit === 1 && /credencial OAuth/.test(denied.out) && same(after, await counts()), denied.out.slice(-300));

    mail = [message('m-g1', [{ filename: 'g1.pdf', mimeType: 'application/pdf', bytes: pdf('g1') }]), message('m-g2', [{ filename: 'g2.pdf', mimeType: 'application/pdf', bytes: pdf('g2') }])];
    const msg = await run(WF.open, { faults: [{ match: /\/messages\/m-g1$/, status: 500 }] });
    check('Fallo al leer un mensaje: el otro sigue, y la ejecución termina con error', msg.exit === 1 && /error_gmail=1/.test(msg.out) && (await docByMessage('m-g1')).length === 0 && (await docByMessage('m-g2')).length === 1, msg.out.slice(-300));
    const att = await run(WF.open, { faults: [{ match: /\/m-g1\/attachments\//, status: 503 }] });
    check('Fallo al descargar un adjunto: no se registra, y la otra repetición no duplica', att.exit === 1 && /error_gmail=1/.test(att.out) && (await docByMessage('m-g1')).length === 0 && (await docByMessage('m-g2')).length === 1, att.out.slice(-300));
    const fin = await run(WF.open);
    check('Reejecutar tras los fallos completa lo pendiente sin duplicar', fin.exit === 0 && fin.conteo?.registrado === 1 && fin.conteo?.ya_registrado === 1 && (await docByMessage('m-g1')).length === 1 && (await docByMessage('m-g2')).length === 1, fin.out.slice(-300));
  }

  await refreshChecks();

  // ---------- Fallos del backend
  {
    mail = [message('m-be', [{ filename: 'be.pdf', mimeType: 'application/pdf', bytes: pdf('be') }])];
    const be = await run(WF.open, { faults: [{ match: /\/internal\/gmail\/attachments$/, status: 503 }] });
    check('Backend 503: error_temporal, ejecución con error y nada registrado', be.exit === 1 && /error_temporal=1/.test(be.out) && (await docByMessage('m-be')).length === 0, be.out.slice(-300));
    const lost = await run(WF.open, { faults: [{ match: /\/internal\/gmail\/attachments$/, mode: 'lost' }] });
    check('Respuesta perdida: el backend sí registró; se informa como error', lost.exit === 1 && /error_temporal=1/.test(lost.out) && (await docByMessage('m-be')).length === 1, lost.out.slice(-300));
    const again = await run(WF.open);
    check('Tras la respuesta perdida, reejecutar no duplica', again.exit === 0 && again.conteo?.ya_registrado === 1 && (await docByMessage('m-be')).length === 1, again.out.slice(-300));
    const before = await counts();
    mail = [message('m-tok', [{ filename: 't.pdf', mimeType: 'application/pdf', bytes: pdf('tok') }])];
    const bad = await run(WF.badToken);
    check('Token de servicio incorrecto: 401, nada registrado, y el token no aparece en la salida', bad.exit === 1 && /token_rechazado=1/.test(bad.out) && same(before, await counts()) && !bad.out.includes(serviceToken), bad.out.slice(-300));
    const res = await fetch(`${API}/internal/gmail/attachments`, { method: 'POST', body: new FormData() });
    check('Solicitud sin autorización: 401', res.status === 401);
    const jwt = await fetch(`${API}/internal/gmail/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${daniel.jwt}` }, body: new FormData() });
    check('JWT de usuario: 401', jwt.status === 401);
    const form = new FormData();
    form.append('mailbox', MAILBOX); form.append('messageId', 'm-owner'); form.append('partId', '1'); form.append('receivedAt', '2026-11-05T12:00:00Z'); form.append('ownerId', ana.profileId);
    form.append('file', new File([pdf('owner')], 'o.pdf', { type: 'application/pdf' }));
    const owner = await fetch(`${API}/internal/gmail/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}` }, body: form });
    check('Elegir propietario en la solicitud: 400', owner.status === 400 && (await docByMessage('m-owner')).length === 0);
  }

  // ---------- Conexión con los workflows 02 y 03: propuesta y revisión humana, sin obligación automática
  {
    // Solo debe quedar el trabajo de este correo: se cierran los anteriores como fallo definitivo.
    for (let i = 0; i < 40; i += 1) {
      const claim = await fetch(`${API}/internal/workflow-jobs/claim`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: 'limpieza', limit: 10, jobTypes: ['document.process'] }) });
      const { jobs } = await claim.json();
      if (!jobs.length) break;
      for (const j of jobs) await fetch(`${API}/internal/workflow-jobs/${j.id}/fail`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ claimToken: j.claimToken, error: 'limpieza de la prueba', retryable: false }) });
    }
    mail = [message('m-real', [{ mimeType: 'text/plain' }, { filename: 'factura-ficticia-positiva.pdf', mimeType: 'application/pdf', bytes: realInvoice }])];
    const before = await counts();
    const g = await run(WF.open);
    const [doc] = await docByMessage('m-real');
    check('Factura ficticia real: registrada desde Gmail', g.exit === 0 && g.conteo?.registrado === 1 && Boolean(doc), g.out.slice(-400));
    const d = await run(WF.doc);
    const caseAfter = (await q('SELECT status, source FROM cases WHERE id = $1', [doc.case_id]))[0];
    const proposals = await q('SELECT id, source, review_status, proposed_data, document_id FROM case_proposals WHERE case_id = $1', [doc.case_id]);
    const hitl = await q('SELECT id, status, decision_type, assigned_to FROM hitl_requests WHERE case_id = $1', [doc.case_id]);
    check('Workflow 02, sin cambios, reclama y procesa el caso de Gmail', d.exit === 0 && caseAfter.status === 'awaiting_human' && caseAfter.source === 'gmail', d.out.slice(-400));
    check('Genera propuesta llm y revisión humana asignada al propietario', proposals.length === 1 && proposals[0].source === 'llm' && proposals[0].document_id === doc.id && hitl.length === 1 && hitl[0].status === 'pending' && hitl[0].assigned_to === daniel.profileId);
    check('Ninguna obligación se registró de forma automática', (await counts()).obligations === before.obligations);
    // Lo que Daniel ve en la aplicación, solo por las rutas públicas de usuario.
    const ids = (r) => (r.body?.items ?? []).map((x) => x.id);
    const documentsD = await api('GET', '/documents?source=gmail&pageSize=100', daniel.jwt);
    const documentsA = await api('GET', '/documents?source=gmail&pageSize=100', ana.jwt);
    check('Daniel ve el documento de Gmail en su lista; Ana no ve ninguno', ids(documentsD).includes(doc.id) && documentsD.body.items.find((x) => x.id === doc.id).source === 'gmail' && ids(documentsA).length === 0, JSON.stringify(documentsA.body));
    const casesD = await api('GET', '/cases?pageSize=100', daniel.jwt);
    const casesA = await api('GET', '/cases?pageSize=100', ana.jwt);
    check('Daniel ve el caso con origen gmail; Ana no', casesD.body?.items?.find((x) => x.id === doc.case_id)?.source === 'gmail' && !ids(casesA).includes(doc.case_id), JSON.stringify(casesD.body).slice(0, 200));
    const propD = await api('GET', `/cases/${doc.case_id}/proposals`, daniel.jwt);
    check('Daniel ve la propuesta; Ana recibe 404', ids(propD).includes(proposals[0].id) && (await api('GET', `/cases/${doc.case_id}/proposals`, ana.jwt)).status === 404, JSON.stringify(propD.body).slice(0, 200));
    const hitlD = await api('GET', `/hitl-requests?caseId=${doc.case_id}`, daniel.jwt);
    check('Daniel ve la revisión pendiente; Ana no', ids(hitlD).includes(hitl[0].id) && ids(await api('GET', `/hitl-requests?caseId=${doc.case_id}`, ana.jwt)).length === 0, JSON.stringify(hitlD.body).slice(0, 200));
    const trayD = await api('GET', '/attention', daniel.jwt);
    const trayA = await api('GET', '/attention', ana.jwt);
    check('La revisión aparece en la bandeja de Daniel y no en la de Ana', trayD.status === 200 && JSON.stringify(trayD.body).includes(hitl[0].id) && !JSON.stringify(trayA.body).includes(hitl[0].id), JSON.stringify(trayD.body).slice(0, 200));
    const contentD = await fetch(`${API}/documents/${doc.id}/content`, { headers: { Authorization: `Bearer ${daniel.jwt}` } });
    check('Daniel descarga el PDF original; Ana no', contentD.status === 200 && Buffer.from(await contentD.arrayBuffer()).equals(realInvoice) && (await fetch(`${API}/documents/${doc.id}/content`, { headers: { Authorization: `Bearer ${ana.jwt}` } })).status === 404);
    check('Ana no puede decidir sobre la revisión', (await api('POST', `/hitl-requests/${hitl[0].id}/decision`, ana.jwt, { decision: 'approved' })).status === 404);
    const n8nToken = await fetch(`${API}/hitl-requests/${hitl[0].id}/decision`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' }, body: '{"decision":"approved"}' });
    check('El token de servicio no puede aprobar', n8nToken.status === 401);
    const approve = await api('POST', `/hitl-requests/${hitl[0].id}/decision`, daniel.jwt, { decision: 'approved', comment: 'prueba local' });
    const apply = await api('POST', `/cases/${doc.case_id}/proposals/${proposals[0].id}/apply`, daniel.jwt, {});
    const [ob] = await q('SELECT owner_id, provider_name FROM obligations WHERE id = $1', [apply.body?.resource?.obligationId]);
    check('Aprobar y aplicar como usuario crea la obligación de Daniel', approve.status === 200 && apply.status === 201 && ob?.owner_id === daniel.profileId, JSON.stringify(apply));
    const c = await run(WF.close);
    const closed = (await q('SELECT status FROM cases WHERE id = $1', [doc.case_id]))[0];
    check('Workflow 03 cierra el caso de Gmail', c.exit === 0 && closed.status === 'completed', c.out.slice(-300));
    const repeat = await run(WF.open);
    check('Volver a consultar el correo no crea una segunda obligación ni caso', repeat.exit === 0 && repeat.conteo?.ya_registrado === 1 && (await docByMessage('m-real')).length === 1 && (await counts()).obligations === before.obligations + 1, repeat.out.slice(-300));
  }

  // ---------- Regresión de archivos
  {
    const status = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'n8n/workflows/01-prueba-de-conexion.json', 'n8n/workflows/02-procesamiento-documental.json', 'n8n/workflows/03-cierre-hitl.json', 'n8n/workflows/04-procesamiento-voz.json', 'frontend', 'README.md', 'docs/frontend'], { encoding: 'utf8' });
    check('Workflows 01-04, frontend, README y guía frontend sin cambios', status.stdout.trim() === '', status.stdout);
  }
} catch (e) {
  failed += 1;
  console.log(`ERR excepción: ${e.stack}`);
} finally {
  console.log(failed ? `FALLARON ${failed} de ${total}` : `Todo correcto: ${total} comprobaciones`);
  if (failed) console.log(apiErr.slice(-400));
  cleanup();
}
process.exitCode = failed ? 1 : 0;
process.exit();
