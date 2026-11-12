/**
 * Genera n8n/workflows/05b-gmail-camila-alias.json a partir del 05 versionado (que NO se modifica).
 *
 * 05b = variante MANUAL del workflow 05 para un único alias de entrega (plus addressing) del mismo buzón OAuth:
 *   - Identidad OAuth (users.getProfile) y dirección de entrega son cosas distintas: se verifican por separado.
 *   - Lista SOLO mensajes con la etiqueta exclusiva del alias (la aplica un filtro de Gmail) y de los últimos días.
 *   - Cada mensaje pasa por resolveDelivery() (n8n/tests/lib/gmail-alias.mjs): etiqueta + primer Delivered-To
 *     coherentes, To/Cc sin contradicciones; ante cualquier duda se RECHAZA sin efectos.
 *   - Al backend se envía `mailbox` = alias esperado; el backend resuelve el propietario con GMAIL_MAILBOX_LINKS.
 *   - Sin disparador programado: solo ejecución manual. Lectura e ingesta tienen interruptores separados (false).
 * El JSON no lleva direcciones ni secretos: buzón, alias y remitentes los escribe n8n/tools/import-workflow.mjs.
 * Uso: node n8n/tests/build-workflow-05b.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDelivery } from './lib/gmail-alias.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../workflows/05-recepcion-gmail.json');
const OUT = join(HERE, '../workflows/05b-gmail-camila-alias.json');
const wf = JSON.parse(readFileSync(SRC, 'utf8'));
const GMAIL_CRED = { googleOAuth2Api: { id: 'nhpGmailRead0001', name: 'NotiHouse Gmail' } };

/** Cada reemplazo debe coincidir exactamente UNA vez: si el 05 cambia, este generador falla en vez de producir algo distinto. */
function patch(code, from, to, what) {
  const parts = code.split(from);
  if (parts.length !== 2) throw new Error(`No se pudo adaptar «${what}»: el 05 cambió (${parts.length - 1} coincidencias).`);
  return parts.join(to);
}
const node = (name) => { const n = wf.nodes.find((x) => x.name === name); if (!n) throw new Error(`Falta el nodo ${name}`); return n; };

// ------------------------------------------------------------------ identidad y alcance
const config = String.raw`// 05b — Gmail por ALIAS (plus addressing). Ejecución MANUAL: no hay disparador programado.
// Interruptores: con ambos en false el workflow no llama a Google ni al backend.
// LECTURA en true y INGESTA en false solo lista qué se procesaría (y a qué alias se asignaría), sin descargar adjuntos.
const AUTORIZAR_LECTURA_GMAIL = false;
const AUTORIZAR_INGESTA = false;

// IDENTIDAD OAuth del buzón (la cuenta que autorizó a n8n) y dirección de ENTREGA del alias: son cosas distintas.
// Sin estos datos el workflow se detiene antes de llamar a Google (los escribe n8n/tools/import-workflow.mjs).
const BUZON_AUTORIZADO = '';
const ALIAS_ENTREGA = '';
const REMITENTES_AUTORIZADOS = [];
// Etiqueta EXCLUSIVA del alias (la aplica un filtro de Gmail) y prefijo de las etiquetas de alias.
const ETIQUETA = 'nh-camila';
const PREFIJO_ETIQUETAS = 'nh-';
// Solo mensajes recientes: nunca el histórico del buzón.
const VENTANA = '2d';

// Solo metadatos de partes: el cuerpo del correo nunca se descarga.
const part = 'partId,mimeType,filename,body(attachmentId,size)';
const nest = (depth) => (depth === 0 ? part : part + ',parts(' + nest(depth - 1) + ')');

return [{ json: {
  readAuthorized: AUTORIZAR_LECTURA_GMAIL === true,
  ingestAuthorized: AUTORIZAR_LECTURA_GMAIL === true && AUTORIZAR_INGESTA === true,
  scheduled: false,
  mailbox: BUZON_AUTORIZADO.trim().toLowerCase(),
  alias: ALIAS_ENTREGA.trim().toLowerCase(),
  allowedSenders: REMITENTES_AUTORIZADOS.map((s) => s.trim().toLowerCase()),
  label: ETIQUETA,
  labelPrefix: PREFIJO_ETIQUETAS,
  window: VENTANA,
  apiBase: 'https://notihouse-pal-api.onrender.com/api/v1',
  gmailBase: 'https://gmail.googleapis.com',
  maxMessages: 5,
  maxAttachmentsPerMessage: 5,
  // Mismo máximo inicial del backend para un PDF, que sigue siendo quien decide.
  maxPdfBytes: 10 * 1024 * 1024,
  messageFields: 'id,internalDate,labelIds,payload(headers(name,value),' + nest(4) + ')',
} }];`;

const validate = String.raw`const cfg = $('Configuracion').first().json;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!email.test(cfg.mailbox)) throw new Error('Falta BUZON_AUTORIZADO (identidad OAuth): no se llamó a Google.');
if (!email.test(cfg.alias)) throw new Error('Falta ALIAS_ENTREGA: no se llamó a Google.');
// El alias debe ser «buzón+etiqueta@dominio» de ESA misma cuenta, y distinto de la dirección general.
const split = (a) => { const [local, domain] = a.split('@'); const plus = local.indexOf('+'); return { base: (plus === -1 ? local : local.slice(0, plus)).replace(/\./g, ''), tag: plus === -1 ? '' : local.slice(plus + 1), domain }; };
const mb = split(cfg.mailbox); const al = split(cfg.alias);
if (al.tag === '' || al.base !== mb.base || al.domain !== mb.domain) throw new Error('ALIAS_ENTREGA no es un alias (buzón+etiqueta@dominio) del buzón autorizado: no se llamó a Google.');
if (cfg.allowedSenders.length === 0 || !cfg.allowedSenders.every((s) => email.test(s))) {
  throw new Error('Falta REMITENTES_AUTORIZADOS: no se llamó a Google.');
}
if (!/^[a-z0-9-]+$/.test(cfg.label) || !cfg.label.startsWith(cfg.labelPrefix)) throw new Error('La etiqueta no es válida o no usa el prefijo de alias: no se llamó a Google.');
if (!/^[1-9][0-9]?d$/.test(cfg.window)) throw new Error('La ventana de antigüedad no es válida: no se llamó a Google.');
// Nunca toda la bandeja: etiqueta exclusiva, adjunto PDF, remitente y antigüedad, todos obligatorios.
const query = 'label:' + cfg.label + ' has:attachment filename:pdf newer_than:' + cfg.window + ' from:(' + cfg.allowedSenders.join(' OR ') + ')';
return [{ json: { query } }];`;

const extractIntro = `// 05b: resolución ESTRICTA del destinatario (la misma función que prueban n8n/tests/gmail-alias.test.mjs).\n${resolveDelivery.toString()}\n`;

// ------------------------------------------------------------------ transformaciones
node('Configuracion').parameters.jsCode = config;
node('Configuracion').notes = 'Interruptores y alcance autorizado (buzón OAuth, alias de entrega, etiqueta, remitentes). En false no se llama a Google ni al backend.';
node('Validar configuracion').parameters.jsCode = validate;

// Mapa de etiquetas (id → nombre): users.labels.list entra en el alcance gmail.readonly. Solo lectura.
const labels = {
  ...structuredClone(node('Perfil de Gmail')),
  id: '7a2c3b50-0b01-4b00-8b00-0000000b0001',
  name: 'Etiquetas de Gmail',
  position: [node('Verificar buzon').position[0] + 110, 200],
  credentials: GMAIL_CRED,
};
labels.parameters.url = labels.parameters.url.replace(/\/profile$/, '/labels');
labels.parameters.queryParameters = { parameters: [{ name: 'fields', value: 'labels(id,name)' }] };
if (!/\/labels$/.test(labels.parameters.url)) throw new Error('No se pudo construir el nodo de etiquetas.');
wf.nodes.push(labels);

// Extraer adjuntos: tras el filtro de remitente, el destinatario debe resolverse sin ambigüedad.
const extract = node('Extraer adjuntos');
let ex = extract.parameters.jsCode;
ex = patch(ex, "const pending = $('Preparar mensajes').all();\n", "const pending = $('Preparar mensajes').all();\nconst labelNames = Object.fromEntries(($('Etiquetas de Gmail').first().json.labels ?? []).map((l) => [l.id, l.name]));\n", 'mapa de etiquetas');
ex = patch(ex, "  const seen = { ...base, from, subject: header(msg, 'subject') };\n",
  "  // Destinatario: dos señales independientes y coherentes, o rechazo sin efectos (ni documento, ni caso, ni trabajo).\n" +
  "  const delivery = resolveDelivery({ headers: msg.payload?.headers ?? [], labelIds: msg.labelIds ?? [], labelNames, expectedAlias: cfg.alias, expectedLabel: cfg.label, labelPrefix: cfg.labelPrefix });\n" +
  "  if (!delivery.ok) {\n    out.push({ json: { ...base, outcome: 'destinatario_rechazado', motivo: delivery.reason } });\n    return;\n  }\n" +
  "  const seen = { ...base, from, subject: header(msg, 'subject'), deliveryMailbox: delivery.mailbox };\n", 'resolución del destinatario');
extract.parameters.jsCode = extractIntro + ex;

// Decodificar: al backend va el ALIAS resuelto (nunca la identidad OAuth ni la dirección general).
const dec = node('Decodificar');
let dc = dec.parameters.jsCode;
dc = patch(dc, "const mailbox = $('Verificar buzon').first().json.mailbox;\n", '', 'buzón en Decodificar');
dc = patch(dc, 'const { attachmentId, download, ...source } = wanted[i].json;', 'const { attachmentId, download, deliveryMailbox, ...source } = wanted[i].json;', 'desestructuración en Decodificar');
dc = patch(dc, 'decoded: true, mailbox,', 'decoded: true, mailbox: deliveryMailbox,', 'campo mailbox en Decodificar');
dec.parameters.jsCode = dc;

// Resumen: los rechazos de destinatario no son fallos de la ejecución (no hay nada que reintentar), pero se cuentan y se explican.
// («destinatario_rechazado» aparece en el conteo y en el detalle con su motivo.)
// Rechazos definitivos del backend (400/413/415, outcome «rechazado»): la ejecución sigue en verde (reintentar no cambia nada),
// pero el resumen deja explícito que el documento NO fue registrado y por qué, sin detalle técnico. Los errores temporales
// (red, 5xx, 429...) siguen haciendo fallar la ejecución: ahí sí conviene reejecutar.
const summary = wf.nodes.find((n) => n.name === 'Resumen');
let sm = summary.parameters.jsCode;
sm = patch(sm, "const detail = items.map(({ attachmentId, download, ...x }) => (cfg.ingestAuthorized ? { ...x, from: undefined, subject: undefined } : x));\n",
  [
    "const REJECTION_NOTE = { 400: 'No se registró: el archivo no cumple las reglas de seguridad o de formato del sistema.', 413: 'No se registró: el archivo supera el tamaño permitido.', 415: 'No se registró: el tipo de archivo no es admitido.' };",
    "const detail = items.map(({ attachmentId, download, ...x }) => {",
    "  const shown = cfg.ingestAuthorized ? { ...x, from: undefined, subject: undefined } : x;",
    "  return x.outcome === 'rechazado' ? { ...shown, registrado: false, mensaje: REJECTION_NOTE[x.httpStatus] ?? 'No se registró: el archivo fue rechazado.' } : shown;",
    "});",
    "",
  ].join('\n'), 'detalle del resumen');
sm = patch(sm, "return [{ json: { modo: cfg.ingestAuthorized ? 'ingesta' : 'solo_revision', conteo: counts, hayMasMensajes: moreMessages, detalle: detail } }];",
  [
    "const rejected = counts.rechazado ?? 0;",
    "const resultado = rejected > 0 ? 'con_rechazos' : 'completo';",
    "const aviso = rejected > 0 ? rejected + ' documento(s) NO fueron registrados porque el sistema los rechazó de forma definitiva; reintentar no cambia el resultado (revisa el detalle).' : undefined;",
    "return [{ json: { modo: cfg.ingestAuthorized ? 'ingesta' : 'solo_revision', resultado, aviso, conteo: counts, hayMasMensajes: moreMessages, detalle: detail } }];",
  ].join('\n'), 'retorno del resumen');
summary.parameters.jsCode = sm;

// Sin disparador programado.
wf.nodes = wf.nodes.filter((n) => !['Disparo programado', 'Marcar programado'].includes(n.name));
delete wf.connections['Disparo programado'];
delete wf.connections['Marcar programado'];

// Conexiones: Verificar buzon → Etiquetas de Gmail → Ingesta autorizada? (fallo → Fallo de Gmail).
wf.connections['Verificar buzon'] = { main: [[{ node: 'Etiquetas de Gmail', type: 'main', index: 0 }]] };
wf.connections['Etiquetas de Gmail'] = { main: [[{ node: 'Ingesta autorizada?', type: 'main', index: 0 }], [{ node: 'Fallo de Gmail', type: 'main', index: 0 }]] };

wf.id = 'nhpGmailCamila01';
wf.name = 'NotiHouse-Pal - 05b - Gmail Camila (alias)';
wf.active = false;

const names = wf.nodes.map((n) => n.name);
const dangling = Object.entries(wf.connections).flatMap(([from, c]) => [from, ...c.main.flat().map((x) => x.node)]).filter((n) => !names.includes(n));
if (dangling.length) throw new Error(`Conexiones rotas: ${dangling.join(', ')}`);

writeFileSync(OUT, `${JSON.stringify(wf, null, 2)}\n`);
console.log(`${OUT} (${wf.nodes.length} nodos)`);
