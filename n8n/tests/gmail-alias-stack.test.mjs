/**
 * Banco de pruebas 100 % local del workflow 05b (Gmail por ALIAS, plus addressing) con el BACKEND REAL compilado:
 * PostgreSQL 18 desechable + `node dist/main` + n8n desechable + un proxy con Gmail simulado (etiquetas, encabezados
 * Delivered-To/To/Cc) y fallos inyectados. Comprueba de extremo a extremo que una factura de Camila nunca termina en
 * Daniel ni al revés, que los casos ambiguos se rechazan SIN efectos, y que lo existente de Daniel queda intacto.
 * No lee backend/.env, exige base local y no puede llamar a Google ni a Neon/Render: puertos y contenedores propios
 * (distintos de gmail-stack), y los dominios de Google apuntan a 127.0.0.1 dentro del contenedor de n8n.
 *
 * Requisitos: Docker y `npm run build` en backend/. Uso: node n8n/tests/gmail-alias-stack.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

const PG_PORT = 55439;
const API_PORT = 3997;
const PROXY_PORT = 18769;
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const REMOTE = `http://host.docker.internal:${PROXY_PORT}`;
const PG_NAME = 'notihouse-alias-pg';
const N8N_NAME = 'notihouse-alias-n8n';
const IMAGE = 'docker.n8n.io/n8nio/n8n:2.46.6';
const MAILBOX = 'notihousepal@gmail.com';
const CAMILA = 'notihousepal+camila@gmail.com';
const DANIEL = 'notihousepal+daniel@gmail.com';
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
const ROOT = mkdtempSync(join(tmpdir(), 'notihouse-alias-'));
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
const camila = await makeUser('camila-local');

// ---------------------------------------------------- Backend real (solo con el entorno de esta prueba)
apiProcess = spawn('node', ['--no-warnings', join(BACKEND, 'dist/main.js')], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'development', PORT: String(API_PORT), DATABASE_URL, JWT_SECRET: jwtSecret, N8N_SERVICE_TOKEN: serviceToken,
    STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: join(ROOT, 'storage'), STORAGE_UPLOAD_TMP_PATH: join(ROOT, 'tmp'),
    STORAGE_MAX_PDF_BYTES: String(MAX_BACKEND_PDF),
    GMAIL_MAILBOX_LINKS: `${MAILBOX}=${daniel.profileId},${CAMILA}=${camila.profileId},${DANIEL}=${daniel.profileId}`,
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
camila.jwt = await login(camila);
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
const LABEL_IDS = { 'nh-camila': 'Label_C', 'nh-daniel': 'Label_D', 'notihouse-facturas-prueba': 'Label_H', INBOX: 'INBOX' };
const message = (id, parts, { from = `Proveedor <${SENDER}>`, subject = 'Factura ficticia', labels, headers = [] } = {}) => ({ id, from, subject, parts, labels, headers });
/** Mensaje entregado a un alias: Delivered-To (primero), To y etiquetas coherentes salvo que se indique otra cosa. */
const aliasMsg = (id, { alias = CAMILA, to = alias, cc, delivered = [alias], labels = ['nh-camila', 'INBOX'], raw, parts, ...rest } = {}) => message(id,
  parts ?? [{ filename: `${id}.pdf`, mimeType: 'application/pdf', bytes: pdf(id) }],
  { labels, headers: raw ?? [...delivered.map((v) => ({ name: 'Delivered-To', value: v })), ...(to === null ? [] : [{ name: 'To', value: to }]), ...(cc ? [{ name: 'Cc', value: cc }] : [])], ...rest });
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
      if (url.pathname.endsWith('/labels')) return json(res, 200, { labels: Object.entries(LABEL_IDS).map(([name, id]) => ({ id, name })) });
      if (url.pathname.endsWith('/messages')) {
        // Como Gmail: la búsqueda por etiqueta la resuelve el servidor. Un mensaje sin lista de etiquetas (casos heredados) coincide siempre.
        const wanted = /label:([a-z0-9-]+)/.exec(url.searchParams.get('q') ?? '')?.[1];
        const listed = mail.filter((m) => !wanted || !m.labels || m.labels.includes(wanted));
        return json(res, 200, { ...(listed.length ? { messages: listed.map((m) => ({ id: m.id })) } : {}), ...(mail.more ? { nextPageToken: 'mas' } : {}) });
      }
      if (seg.includes('attachments')) {
        const bytes = issued.get(`${seg[5]}/${seg[7]}`);
        if (!bytes) { entry.status = 404; return json(res, 404, {}); }
        return json(res, 200, { size: bytes.length, data: b64url(bytes) });
      }
      const m = mail.find((x) => x.id === seg[5]);
      if (!m) { entry.status = 404; return json(res, 404, {}); }
      return json(res, 200, {
        id: m.id, internalDate: String(Date.parse('2026-11-05T12:00:00Z')), labelIds: (m.labels ?? []).map((n) => LABEL_IDS[n] ?? n),
        payload: { partId: '', mimeType: 'multipart/mixed', filename: '', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, ...m.headers], body: { size: 0 }, parts: m.parts.map((p, i) => renderPart(p, String(i), m.id)) },
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
const wf05b = JSON.parse(readFileSync(join(REPO, 'n8n/workflows/05b-gmail-camila-alias.json'), 'utf8'));
const variantB = (id, { read = false, ingest = false, mailbox = MAILBOX, alias = CAMILA, senders = [SENDER], label = 'nh-camila' } = {}) => {
  const w = JSON.parse(JSON.stringify(wf05b));
  const config = w.nodes.find((n) => n.name === 'Configuracion');
  config.parameters.jsCode = config.parameters.jsCode
    .replace('https://notihouse-pal-api.onrender.com/api/v1', `${REMOTE}/api/v1`)
    .replace('https://gmail.googleapis.com', REMOTE)
    .replace('AUTORIZAR_LECTURA_GMAIL = false', `AUTORIZAR_LECTURA_GMAIL = ${read}`)
    .replace('AUTORIZAR_INGESTA = false', `AUTORIZAR_INGESTA = ${ingest}`)
    .replace("BUZON_AUTORIZADO = ''", `BUZON_AUTORIZADO = '${mailbox}'`)
    .replace("ALIAS_ENTREGA = ''", `ALIAS_ENTREGA = '${alias}'`)
    .replace('REMITENTES_AUTORIZADOS = []', `REMITENTES_AUTORIZADOS = ${JSON.stringify(senders)}`)
    .replace("ETIQUETA = 'nh-camila'", `ETIQUETA = '${label}'`);
  w.id = id; w.name = id;
  writeFileSync(join(WORK, `${id}.json`), JSON.stringify(w));
  return id;
};
const WF = {
  legacy: variant('test05Legacy00001', { read: true, ingest: true }),
  closed: variantB('test05bClosed0001'),
  empty: variantB('test05bEmpty00001', { read: true, ingest: true, mailbox: '', senders: [] }),
  review: variantB('test05bReview0001', { read: true }),
  camila: variantB('test05bCamila0001', { read: true, ingest: true }),
  daniel: variantB('test05bDaniel0001', { read: true, ingest: true, alias: DANIEL, label: 'nh-daniel' }),
  badAliasBase: variantB('test05bBadBase0001', { read: true, ingest: true, alias: 'otrabandeja+camila@gmail.com' }),
  badAliasPlain: variantB('test05bBadPlain001', { read: true, ingest: true, alias: MAILBOX }),
  badAliasEmpty: variantB('test05bBadEmpty001', { read: true, ingest: true, alias: '' }),
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


// ---------------------------------------------------- Utilidades específicas de la matriz de alias
const sha32 = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex').slice(0, 32);
const keyFor = (mailbox, id, part = '0') => `gmail:${sha32(mailbox)}:${id}:${part}`;
/** Elementos del «detalle» del Resumen del workflow (outcome, motivo, deliveryMailbox...). */
const detail = (out) => {
  const i = out.indexOf('"detalle": [');
  if (i < 0) return [];
  const start = out.indexOf('[', i);
  let depth = 0; let end = start;
  for (; end < out.length; end += 1) {
    if (out[end] === '[') depth += 1;
    else if (out[end] === ']') { depth -= 1; if (depth === 0) break; }
  }
  try { return JSON.parse(out.slice(start, end + 1)); } catch { return []; }
};
const byId = (out) => Object.fromEntries(detail(out).map((x) => [x.messageId, x]));
const auditOf = async (id) => q(`SELECT action, actor_type, actor_id, owner_id FROM audit_events WHERE metadata::text LIKE $1`, [`%${id}%`]);
const jobKeys = async () => (await q('SELECT idempotency_key FROM workflow_jobs')).map((r) => r.idempotency_key);
const postDirect = async (fields, bytes = pdf('directo')) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'directo.pdf');
  const res = await fetch(`${API}/internal/gmail/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${serviceToken}` }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const note = (id, extra = {}) => ({ messageId: id, partId: '0', receivedAt: '2026-11-05T12:00:00Z', ...extra });

try {
  // ---------- 0) Preexistente de Daniel (workflow 05 original, dirección general): quedará intacto
  const historic = [message('m-hist', [{ filename: 'hist.pdf', mimeType: 'application/pdf', bytes: pdf('historico-daniel') }])];
  mail = historic;
  const h0 = await run(WF.legacy);
  const snapshotDaniel = async () => ({
    docs: await q("SELECT id, owner_id, external_message_id, sha256, case_id FROM documents WHERE owner_id = $1 ORDER BY id", [daniel.profileId]),
    cases: await q('SELECT id, owner_id, status, source FROM cases WHERE owner_id = $1 ORDER BY id', [daniel.profileId]),
    jobs: await q('SELECT w.id, w.idempotency_key, w.status FROM workflow_jobs w JOIN cases c ON c.id = w.case_id WHERE c.owner_id = $1 ORDER BY w.id', [daniel.profileId]),
  });
  const danielBefore = await snapshotDaniel();
  check('05 original (dirección general) sigue registrando para Daniel (vínculo heredado intacto)', h0.exit === 0 && h0.conteo?.registrado === 1 && danielBefore.docs.length === 1 && danielBefore.docs[0].owner_id === daniel.profileId, h0.out.slice(-300));
  check('Su clave de deduplicación usa la dirección general (hash del buzón base)', (await jobKeys()).includes(keyFor(MAILBOX, 'm-hist')), JSON.stringify(await jobKeys()));

  // ---------- 1) Interruptores y configuración (el 05b nunca llama a Google ni al backend sin autorización válida)
  {
    mail = [aliasMsg('m-closed')];
    const before = await counts();
    const r = await run(WF.closed);
    check('05b con interruptores en false: ni Google ni backend', r.exit === 0 && r.log.length === 0 && same(before, await counts()), JSON.stringify(r.log));
    const e = await run(WF.empty);
    check('05b sin buzón OAuth ni remitentes: se detiene antes de llamar a Google', e.exit === 1 && e.log.length === 0 && /BUZON_AUTORIZADO/.test(e.out), e.out.slice(0, 300));
    for (const [k, why] of [['badAliasBase', 'alias de otra bandeja'], ['badAliasPlain', 'dirección general como alias'], ['badAliasEmpty', 'alias vacío']]) {
      const r2 = await run(WF[k]);
      check(`05b con ${why}: se detiene antes de llamar a Google`, r2.exit === 1 && r2.log.length === 0 && /ALIAS_ENTREGA/.test(r2.out), r2.out.slice(0, 300));
    }
  }

  // ---------- 2) Modo revisión: muestra a qué alias se asignaría, sin descargar ni escribir
  {
    mail = [aliasMsg('m-rev1'), aliasMsg('m-rev2', { labels: ['nh-camila'], delivered: [DANIEL], to: DANIEL })];
    const before = await counts();
    const r = await run(WF.review);
    const d = byId(r.out);
    check('Revisión: nada se descarga ni se escribe (ingesta bloqueada con AUTORIZAR_INGESTA=false)', r.exit === 0 && downloads(r.log).length === 0 && backendWrites(r.log).length === 0 && same(before, await counts()), r.out.slice(-400));
    check('Revisión: el mensaje válido muestra el alias resuelto (la dirección esperada) y queda pendiente de autorización', d['m-rev1']?.outcome === 'pendiente_de_autorizacion' && d['m-rev1']?.deliveryMailbox === CAMILA, JSON.stringify(d['m-rev1']));
    check('Revisión: el mensaje de otro alias muestra el rechazo y su motivo', d['m-rev2']?.outcome === 'destinatario_rechazado' && d['m-rev2']?.motivo === 'alias_distinto', JSON.stringify(d['m-rev2']));
    const labelsCall = r.log.filter((e) => /\/labels$/.test(e.path));
    const list = r.log.find((e) => e.path.endsWith('/messages'));
    check('Pide el mapa de etiquetas (GET, solo lectura) una vez', labelsCall.length === 1 && labelsCall[0].method === 'GET');
    check('La consulta exige etiqueta exclusiva, PDF, remitente y ventana de 2 días (nunca la bandeja entera)', /label:nh-camila/.test(list?.query?.q) && /has:attachment filename:pdf/.test(list?.query?.q) && /newer_than:2d/.test(list?.query?.q) && list?.query?.q.includes(SENDER) && !/deliveredto/i.test(list?.query?.q), list?.query?.q);
    check('Todo acceso a Gmail es GET con la credencial de solo lectura', gmailCalls(r.log).every((e) => e.method === 'GET' && e.auth === `Bearer ${FAKE_ACCESS_TOKEN}`));
  }

  // ---------- 3) Identidad OAuth ≠ dirección de entrega: el alias nunca sustituye a la identidad
  {
    mail = [aliasMsg('m-id1')];
    profileAddress = 'otra.cuenta@gmail.com';
    const before = await counts();
    const r = await run(WF.camila);
    check('Si la credencial OAuth pertenece a otra cuenta, no se lee ningún mensaje ni se registra nada', r.exit === 1 && /no corresponde al buz/.test(r.out) && !r.log.some((e) => e.path.endsWith('/messages')) && same(before, await counts()), r.out.slice(-300));
    profileAddress = MAILBOX;
    profileAddress = `${CAMILA}`;
    const r2 = await run(WF.camila);
    check('El alias tampoco sirve como identidad OAuth (users.getProfile debe devolver la cuenta real)', r2.exit === 1 && !r2.log.some((e) => e.path.endsWith('/messages')), r2.out.slice(-200));
    profileAddress = MAILBOX;
  }

  // ---------- 4) Matriz A (Camila): válido + cuatro rechazos distintos
  {
    mail = [
      aliasMsg('m-a1'),
      aliasMsg('m-a2', { to: DANIEL }),
      aliasMsg('m-a3', { alias: 'notihousepal+otro@gmail.com', labels: ['nh-camila'] }),
      aliasMsg('m-a4', { to: MAILBOX, delivered: [MAILBOX] }),
      aliasMsg('m-a5', { labels: ['nh-camila', 'nh-daniel'] }),
    ];
    const before = await counts();
    const r = await run(WF.camila);
    const d = byId(r.out);
    const after = await counts();
    check('A: un solo mensaje registrado (Camila) y cuatro rechazados por destinatario (sin fallos de ejecución)', r.exit === 0 && r.conteo?.registrado === 1 && r.conteo?.destinatario_rechazado === 4, JSON.stringify(r.conteo));
    check('A: motivos exactos de cada rechazo', d['m-a2']?.motivo === 'destinatarios_contradictorios' && d['m-a3']?.motivo === 'alias_distinto' && d['m-a4']?.motivo === 'direccion_general' && d['m-a5']?.motivo === 'etiqueta_incoherente', JSON.stringify(detail(r.out).map((x) => [x.messageId, x.motivo])));
    check('A: solo se creó 1 documento, 1 caso y 1 trabajo (los rechazos no dejan rastro)', same(delta(before, after), { documents: 1, cases: 1, jobs: 1, obligations: 0, proposals: 0, hitl: 0 }), JSON.stringify(delta(before, after)));
    const a1 = await docByMessage('m-a1');
    check('A: el documento y el caso son de CAMILA (propietario resuelto por el backend)', a1.length === 1 && a1[0].owner_id === camila.profileId && a1[0].case_owner === camila.profileId && a1[0].case_source === 'gmail', JSON.stringify(a1));
    for (const id of ['m-a2', 'm-a3', 'm-a4', 'm-a5']) check(`A: ${id} rechazado no creó documento ni auditoría`, (await docByMessage(id)).length === 0 && (await auditOf(id)).length === 0);
    const dl = await api('GET', `/documents/${a1[0].id}`, daniel.jwt);
    const cl = await api('GET', `/documents/${a1[0].id}`, camila.jwt);
    check('A: Daniel no puede ver el documento de Camila (404) y Camila sí (200)', dl.status === 404 && cl.status === 200, `${dl.status}/${cl.status}`);
  }

  // ---------- 5) Matriz B (Camila): encabezados duplicados/ausentes/malformados, reenvíos y Bcc
  {
    const pdfPart = (id) => [{ filename: `${id}.pdf`, mimeType: 'application/pdf', bytes: pdf(id) }];
    mail = [
      aliasMsg('m-b1', { raw: [{ name: 'Delivered-To', value: CAMILA }, { name: 'To', value: CAMILA }, { name: 'To', value: CAMILA }] }),
      aliasMsg('m-b2', { raw: [{ name: 'To', value: CAMILA }] }),
      aliasMsg('m-b3', { raw: [{ name: 'Delivered-To', value: 'notihousepal+@gmail.com' }, { name: 'To', value: CAMILA }] }),
      aliasMsg('m-b4', { parts: [{ mimeType: 'message/rfc822', parts: [{ filename: 'reenviado.pdf', mimeType: 'application/pdf', bytes: pdf('m-b4') }] }] }),
      aliasMsg('m-b5', { to: 'Otra Persona <otra@ejemplo.test>', parts: pdfPart('m-b5') }),
    ];
    const before = await counts();
    const r = await run(WF.camila);
    const d = byId(r.out);
    const after = await counts();
    check('B: encabezado To duplicado, Delivered-To ausente y «+» vacío → rechazo con motivo', d['m-b1']?.motivo === 'encabezados_duplicados' && d['m-b2']?.motivo === 'sin_delivered_to' && d['m-b3']?.motivo === 'alias_malformado', `exit=${r.exit} ${JSON.stringify(detail(r.out).map((x) => [x.messageId, x.motivo ?? x.outcome]))} ${r.out.slice(-700)}`);
    check('B: reenvío (message/rfc822): no se entra en el mensaje reenviado, sin efectos', d['m-b4']?.outcome === 'sin_adjuntos');
    check('B: Bcc (To ajeno) con Delivered-To de Camila y etiqueta coherente → registrado', d['m-b5']?.outcome === 'registrado', `${JSON.stringify(d['m-b5'])} ${r.out.slice(-500)}`);
    check('B: solo el Bcc válido creó datos (1 documento, 1 caso, 1 trabajo)', same(delta(before, after), { documents: 1, cases: 1, jobs: 1, obligations: 0, proposals: 0, hitl: 0 }), JSON.stringify(delta(before, after)));
    const b5 = await docByMessage('m-b5');
    check('B: el Bcc quedó a nombre de Camila', b5.length === 1 && b5[0].owner_id === camila.profileId, JSON.stringify(b5));
    mail = [aliasMsg('m-b6', { delivered: ['reenvio@otro.test', CAMILA] })];
    const r2 = await run(WF.camila);
    check('B: primer Delivered-To de otra cuenta (reenvío automático) → rechazo', byId(r2.out)['m-b6']?.motivo === 'delivered_to_no_propio' && same(after, await counts()), JSON.stringify(detail(r2.out)));
  }

  // ---------- 6) Mensajes que Gmail ni siquiera lista (histórico sin alias, etiqueta de otro alias): sin efectos
  {
    mail = [
      message('m-c1', [{ filename: 'viejo.pdf', mimeType: 'application/pdf', bytes: pdf('viejo') }], { labels: ['notihouse-facturas-prueba'] }),
      aliasMsg('m-c2', { alias: DANIEL, labels: ['nh-daniel'] }),
    ];
    const before = await counts();
    const r = await run(WF.camila);
    check('C: correo histórico (solo etiqueta antigua) y correo de otra etiqueta no se listan ni se procesan', r.exit === 0 && downloads(r.log).length === 0 && backendWrites(r.log).length === 0 && same(before, await counts()) && detail(r.out).length === 0, r.out.slice(-300));
  }

  // ---------- 7) Daniel con su alias (QA de preservación); contradicciones entre flujos
  {
    mail = [aliasMsg('m-d1', { alias: DANIEL, labels: ['nh-daniel', 'INBOX'] }), aliasMsg('m-d2', { labels: ['nh-daniel'] })];
    const before = await counts();
    const r = await run(WF.daniel);
    const d = byId(r.out);
    const after = await counts();
    check('D: alias de Daniel + etiqueta nh-daniel → registrado a nombre de DANIEL', d['m-d1']?.outcome === 'registrado' && (await docByMessage('m-d1'))[0]?.owner_id === daniel.profileId, JSON.stringify(d['m-d1']));
    check('D: mensaje entregado al alias de Camila pero con la etiqueta de Daniel → rechazado, nunca asignado a Daniel', d['m-d2']?.motivo === 'alias_distinto' && (await docByMessage('m-d2')).length === 0, JSON.stringify(d['m-d2']));
    check('D: solo el mensaje válido creó datos', same(delta(before, after), { documents: 1, cases: 1, jobs: 1, obligations: 0, proposals: 0, hitl: 0 }), JSON.stringify(delta(before, after)));
  }

  // ---------- 8) Idempotencia, conflicto, fallo temporal y reintento seguro
  {
    mail = [aliasMsg('m-a1')];
    const before = await counts();
    const auditBefore = (await auditOf('m-a1')).length;
    const r = await run(WF.camila);
    check('Repetir el mismo mensaje: ya_registrado, sin documentos, casos ni trabajos nuevos, sin auditoría nueva', r.exit === 0 && r.conteo?.ya_registrado === 1 && same(before, await counts()) && (await auditOf('m-a1')).length === auditBefore, r.out.slice(-300));
    mail = [aliasMsg('m-a1', { parts: [{ filename: 'm-a1.pdf', mimeType: 'application/pdf', bytes: pdf('contenido-distinto') }] })];
    const c = await run(WF.camila);
    check('Mismo mensaje y parte con contenido distinto: conflicto previsto (409), sin cambios', c.exit === 1 && /conflicto=1/.test(c.out) && same(before, await counts()), c.out.slice(-300));
    mail = [aliasMsg('m-t1')];
    const t = await run(WF.camila, { faults: [{ match: /\/internal\/gmail\/attachments$/, method: 'POST', status: 503 }] });
    check('Fallo temporal del backend (503): error_temporal y NADA registrado', t.exit === 1 && /error_temporal=1/.test(t.out) && same(before, await counts()) && (await docByMessage('m-t1')).length === 0, t.out.slice(-300));
    const t2 = await run(WF.camila);
    check('Reintento tras el fallo: se registra una sola vez', t2.exit === 0 && t2.conteo?.registrado === 1 && (await docByMessage('m-t1')).length === 1, t2.out.slice(-300));
    const t3 = await run(WF.camila);
    check('Reintento posterior: ya_registrado, sin duplicados', t3.exit === 0 && t3.conteo?.ya_registrado === 1 && (await docByMessage('m-t1')).length === 1);
  }

  // ---------- 9) Defensa en profundidad del backend (no depende de n8n)
  {
    const before = await counts();
    const unknown = await postDirect({ mailbox: 'notihousepal+otro@gmail.com', ...note('m-x1') });
    check('Backend: un alias sin vínculo configurado responde 403 y no registra nada', unknown.status === 403 && same(before, await counts()), `${unknown.status} ${JSON.stringify(unknown.body).slice(0, 160)}`);
    const withOwner = await postDirect({ mailbox: CAMILA, ownerId: daniel.profileId, ...note('m-x2') });
    check('Backend: un cliente no puede indicar el propietario (ownerId se rechaza, 400)', withOwner.status === 400 && same(before, await counts()), `${withOwner.status}`);
    const jwtTry = await fetch(`${API}/internal/gmail/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${camila.jwt}` }, body: new FormData() });
    check('Backend: el JWT de un usuario no sirve en la ruta interna (401)', jwtTry.status === 401);
    const dotted = await postDirect({ mailbox: 'notiho.usepal+camila@gmail.com', ...note('m-x3') });
    check('Backend: una variante de la dirección que no está configurada tampoco resuelve (403; fallo seguro)', dotted.status === 403 && same(before, await counts()), `${dotted.status}`);
  }

  // ---------- 10) Propiedad, claves y auditoría de TODO lo registrado
  {
    const expected = { 'gmail:m-hist': daniel, 'gmail:m-a1': camila, 'gmail:m-b5': camila, 'gmail:m-t1': camila, 'gmail:m-d1': daniel };
    const rows = await q("SELECT d.external_message_id AS ext, d.owner_id AS owner, c.owner_id AS case_owner FROM documents d JOIN cases c ON c.id = d.case_id WHERE d.source = 'gmail' ORDER BY d.created_at");
    check('SQL: exactamente los 5 mensajes válidos están registrados (ningún rechazado dejó rastro)', rows.length === 5 && rows.every((r) => expected[r.ext]), JSON.stringify(rows.map((r) => r.ext)));
    check('SQL: documento y caso pertenecen SIEMPRE al propietario correcto (Camila nunca en Daniel, ni al revés)', rows.every((r) => r.owner === expected[r.ext].profileId && r.case_owner === expected[r.ext].profileId), JSON.stringify(rows));
    const dup = await q("SELECT external_message_id, count(*)::int n FROM documents WHERE source = 'gmail' GROUP BY 1 HAVING count(*) > 1");
    check('SQL: ningún documento duplicado', dup.length === 0);
    const keys = await jobKeys();
    check('Claves de deduplicación: alias de Camila y de Daniel con su hash; el histórico con el hash de la dirección general', keys.includes(keyFor(CAMILA, 'm-a1')) && keys.includes(keyFor(CAMILA, 'm-b5')) && keys.includes(keyFor(DANIEL, 'm-d1')) && keys.includes(keyFor(MAILBOX, 'm-hist')) && !keys.includes(keyFor(MAILBOX, 'm-a1')), JSON.stringify(keys));
    check('Las claves nunca incluyen una dirección en claro', keys.every((k) => !/@/.test(k)));
    const gm = await q("SELECT count(*)::int n FROM workflow_jobs w JOIN cases c ON c.id = w.case_id WHERE w.idempotency_key LIKE 'gmail:%' AND c.source <> 'gmail'");
    check('Todo trabajo de Gmail pertenece a un caso de origen gmail', gm[0].n === 0);
    for (const [id, who] of [['m-a1', camila], ['m-b5', camila], ['m-d1', daniel]]) {
      const au = await auditOf(id);
      check(`Auditoría de ${id}: eventos del propietario correcto y actor gmail-intake`, au.length > 0 && au.every((a) => a.owner_id === who.profileId) && au.some((a) => /gmail-intake/.test(a.actor_id ?? '')), JSON.stringify(au));
    }
    const danielAfter = await snapshotDaniel();
    check('El registro HISTÓRICO de Daniel (documento, caso, trabajo y clave) permanece idéntico tras toda la matriz', JSON.stringify(danielAfter.docs.filter((x) => x.external_message_id === 'gmail:m-hist')) === JSON.stringify(danielBefore.docs) && JSON.stringify(danielAfter.cases.filter((x) => x.id === danielBefore.cases[0].id)) === JSON.stringify(danielBefore.cases) && JSON.stringify(danielAfter.jobs.filter((x) => x.id === danielBefore.jobs[0].id)) === JSON.stringify(danielBefore.jobs));
    check('Daniel solo tiene registros propios: histórico + su alias (2 documentos)', danielAfter.docs.length === 2, String(danielAfter.docs.length));
  }

  // ---------- 11) Regresión de archivos
  {
    const status = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'n8n/workflows/01-prueba-de-conexion.json', 'n8n/workflows/05-recepcion-gmail.json', 'frontend', 'backend/src'], { encoding: 'utf8' });
    check('Workflow 01, el 05 original, el frontend y el backend sin cambios', status.stdout.trim() === '', status.stdout);
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
