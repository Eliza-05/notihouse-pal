/**
 * Importa un workflow del repo en un n8n local (contenedor Docker) resolviendo
 * las credenciales por NOMBRE y TIPO. El JSON versionado lleva ids marcador; el
 * id real solo existe en cada instalación de n8n y nunca se escribe en el repo.
 *
 * Uso:
 *   node n8n/tools/import-workflow.mjs <workflow.json> [--container notihouse-n8n] [--dry-run]
 *
 * - Solo lee id, nombre y tipo de las credenciales (no las descifra).
 * - No activa nada: rechaza workflows con `active: true`.
 * - Con --dry-run solo muestra la sustitución, sin importar.
 * - Valores locales (nunca versionados), solo para el workflow 05 y solo en n8n:
 *     N8N_GMAIL_MAILBOX   buzón autorizado, una dirección
 *     N8N_GMAIL_SENDERS   remitentes autorizados, separados por comas
 *   Se escriben en las constantes BUZON_AUTORIZADO y REMITENTES_AUTORIZADOS de la copia
 *   que se importa. Sin ellas esas constantes quedan vacías y el workflow se detiene.
 *   La salida solo muestra las direcciones parcialmente ocultas.
 * - Opciones SOLO PARA QA LOCAL (modifican únicamente la copia importada, nunca el repo):
 *     --api-base <url>     sustituye apiBase (solo http://host.docker.internal:<puerto>/api/v1 o localhost)
 *     --gemini-base <url>  sustituye geminiBase (solo host local, p. ej. el Gemini simulado)
 *     --qa-authorize       pone en true los interruptores AUTORIZAR_* (nunca AUTOMATIZACION_PROGRAMADA);
 *                          exige --api-base local para que jamás apunte a Render.
 * - Tras importar, exporta el workflow y comprueba que cada nodo quedó con el id real.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
let file; let container = 'notihouse-n8n'; let dry = false; let apiBase; let geminiBase; let qaAuthorize = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--container') { container = args[i + 1]; i += 1; } else if (args[i] === '--dry-run') dry = true; else if (args[i] === '--api-base') { apiBase = args[i + 1]; i += 1; } else if (args[i] === '--gemini-base') { geminiBase = args[i + 1]; i += 1; } else if (args[i] === '--qa-authorize') qaAuthorize = true; else file = args[i];
}
if (!file) { console.error('Uso: node n8n/tools/import-workflow.mjs <workflow.json> [--container nombre] [--dry-run]'); process.exit(2); }

const docker = (input, ...a) => spawnSync('docker', a, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const n8nJson = (cmd) => {
  const r = docker(undefined, 'exec', container, 'sh', '-c', `${cmd} 2>/dev/null`);
  if (r.status !== 0) throw new Error(`No se pudo ejecutar «${cmd}» en ${container}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
};

const wf = JSON.parse(readFileSync(resolve(file), 'utf8'));
if (wf.active) throw new Error('El workflow del repo está activo: no se importa.');

// Credenciales existentes: solo id, nombre y tipo.
const known = n8nJson('n8n export:credentials --all').map((c) => ({ id: c.id, name: c.name, type: c.type }));
const resolved = new Map();
let changed = 0;
for (const node of wf.nodes) {
  for (const [type, ref] of Object.entries(node.credentials ?? {})) {
    const key = `${type}|${ref.name}`;
    if (!resolved.has(key)) {
      const matches = known.filter((c) => c.type === type && c.name === ref.name);
      if (matches.length !== 1) throw new Error(`Se esperaba exactamente 1 credencial «${ref.name}» (${type}) en n8n y hay ${matches.length}. Créala o renómbrala.`);
      resolved.set(key, matches[0].id);
    }
    const id = resolved.get(key);
    if (ref.id !== id) { ref.id = id; changed += 1; }
  }
}
for (const [key, id] of resolved) console.log(`  ${key.replace('|', ' → «')}» = ${id}`);
console.log(`Referencias de credencial ajustadas: ${changed}`);

// Valores locales del alcance autorizado (no se escriben en el repo).
const emailRe = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/;
const mask = (a) => a.replace(/^(.{2})[^@]*(@.).*(\..+)$/, '$1***$2***$3');
const mailbox = (process.env.N8N_GMAIL_MAILBOX ?? '').trim().toLowerCase();
const senders = (process.env.N8N_GMAIL_SENDERS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
if (mailbox || senders.length) {
  if (!emailRe.test(mailbox) || senders.length === 0 || !senders.every((x) => emailRe.test(x))) throw new Error('N8N_GMAIL_MAILBOX debe ser una dirección y N8N_GMAIL_SENDERS una o más, separadas por comas.');
  const node = wf.nodes.find((n) => n.name === 'Configuracion');
  const before = node.parameters.jsCode;
  const after = before
    .replace("const BUZON_AUTORIZADO = '';", () => `const BUZON_AUTORIZADO = '${mailbox}';`)
    .replace('const REMITENTES_AUTORIZADOS = [];', () => `const REMITENTES_AUTORIZADOS = [${senders.map((x) => `'${x}'`).join(', ')}];`);
  if (after === before || after.includes("BUZON_AUTORIZADO = '';")) throw new Error('El nodo Configuracion no tiene las constantes vacías esperadas: no se importa.');
  node.parameters.jsCode = after;
  console.log(`  Buzón autorizado: ${mask(mailbox)}; remitentes: ${senders.map(mask).join(', ')}`);
}

// El JSON del repo nunca puede traer los interruptores en true (se comprueba ANTES de las opciones QA).
const repoConfig = wf.nodes.find((n) => n.name === 'Configuracion')?.parameters?.jsCode ?? '';

// Opciones de QA local: solo hacia hosts locales.
const LOCAL = /^http:\/\/(host\.docker\.internal|localhost|127\.0\.0\.1):\d+(\/api\/v1)?$/;
if (apiBase && !LOCAL.test(apiBase)) throw new Error('--api-base solo admite un host local');
if (geminiBase && !LOCAL.test(geminiBase)) throw new Error('--gemini-base solo admite un host local');
if (qaAuthorize && !apiBase) throw new Error('--qa-authorize exige --api-base local');
if (apiBase || geminiBase || qaAuthorize) {
  for (const node of wf.nodes.filter((n) => n.name === 'Configuracion' && n.parameters?.jsCode)) {
    let c = node.parameters.jsCode;
    if (apiBase) c = c.replace(/apiBase: '[^']*'/, () => `apiBase: '${apiBase}'`);
    if (geminiBase) c = c.replace(/geminiBase: '[^']*'/, () => `geminiBase: '${geminiBase}'`);
    if (qaAuthorize) c = c.replace(/const (AUTORIZAR_[A-Z_]+) = false;/g, 'const $1 = true;');
    node.parameters.jsCode = c;
  }
  console.log('  Opciones QA aplicadas a la copia importada: ' + [apiBase && 'apiBase', geminiBase && 'geminiBase', qaAuthorize && 'AUTORIZAR_*'].filter(Boolean).join(', '));
}
// Con ambos interruptores en false el workflow no puede llamar a Google ni al backend.
const config = repoConfig;
for (const sw of ['AUTORIZAR_LECTURA_GMAIL', 'AUTORIZAR_INGESTA', 'AUTORIZAR_RECLAMACION']) {
  if (new RegExp(`${sw} = true`).test(config)) throw new Error(`${sw} está en true en el JSON del repo: no se importa.`);
}
if (dry) { console.log('--dry-run: no se importó nada.'); process.exit(0); }

// El archivo lo crea el usuario `node` del contenedor para poder borrarlo después.
const tmp = `/tmp/import-${wf.id}-${process.pid}.json`;
const put = docker(JSON.stringify(wf), 'exec', '-i', container, 'sh', '-c', `cat > ${tmp}`);
if (put.status !== 0) throw new Error(put.stderr);
const imp = docker(undefined, 'exec', container, 'sh', '-c', `n8n import:workflow --input=${tmp} 2>&1 | tail -2; rm -f ${tmp}`);
console.log(imp.stdout.trim());

const after = n8nJson('n8n export:workflow --all').find((w) => w.id === wf.id);
const bad = after.nodes.flatMap((n) => Object.entries(n.credentials ?? {}).map(([t, r]) => ({ n: n.name, t, id: r.id })))
  .filter((r) => !new Set(resolved.values()).has(r.id));
if (!after || bad.length || after.active) throw new Error(`Verificación fallida: ${JSON.stringify(bad)} active=${after?.active}`);
console.log(`Verificado: ${after.nodes.filter((n) => n.credentials).length} nodos con credencial real; active=${after.active}`);
