/**
 * Genera n8n/workflows/05-recepcion-gmail.json. El JSON no lleva secretos: las
 * credenciales se referencian por id y viven cifradas en n8n.
 * Uso: node n8n/tests/build-workflow-05.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../workflows/05-recepcion-gmail.json');
// Id MARCADOR: el id real de la credencial lo genera cada instalación de n8n y no se versiona.
// n8n/tools/import-workflow.mjs lo sustituye al importar (ver docs/api/ingestion-api.md).
const GMAIL_CRED = { googleOAuth2Api: { id: 'nhpGmailRead0001', name: 'NotiHouse Gmail' } };
const API_CRED = { httpHeaderAuth: { id: 'nhpApiService001', name: 'NotiHouse-Pal API (servicio)' } };

const config = String.raw`// Interruptores: con ambos en false el workflow no llama a Google ni al backend.
// LECTURA en true y INGESTA en false solo lista qué se procesaría, sin descargar adjuntos.
const AUTORIZAR_LECTURA_GMAIL = false;
const AUTORIZAR_INGESTA = false;
// Etapa 7 — ejecución PROGRAMADA (cada 15 min, objetivo del PDD). Exige además
// los dos interruptores anteriores. Con false, una ejecución programada no
// llama a Google ni al backend; la ejecución manual no cambia.
const AUTOMATIZACION_PROGRAMADA = false;
const scheduled = $input.first()?.json?.scheduled === true;
const allowedNow = !scheduled || AUTOMATIZACION_PROGRAMADA === true;

// Alcance autorizado. Sin estos datos el workflow se detiene antes de llamar a Google.
const BUZON_AUTORIZADO = '';
const REMITENTES_AUTORIZADOS = [];
const ETIQUETA = 'notihouse-facturas-prueba';

// Solo metadatos de partes: el cuerpo del correo nunca se descarga.
const part = 'partId,mimeType,filename,body(attachmentId,size)';
const nest = (depth) => (depth === 0 ? part : part + ',parts(' + nest(depth - 1) + ')');

return [{ json: {
  readAuthorized: AUTORIZAR_LECTURA_GMAIL === true && allowedNow,
  ingestAuthorized: AUTORIZAR_LECTURA_GMAIL === true && AUTORIZAR_INGESTA === true && allowedNow,
  scheduled,
  mailbox: BUZON_AUTORIZADO.trim().toLowerCase(),
  allowedSenders: REMITENTES_AUTORIZADOS.map((s) => s.trim().toLowerCase()),
  label: ETIQUETA,
  apiBase: 'https://notihouse-pal-api.onrender.com/api/v1',
  gmailBase: 'https://gmail.googleapis.com',
  maxMessages: 5,
  maxAttachmentsPerMessage: 5,
  // Mismo máximo inicial del backend para un PDF, que sigue siendo quien decide.
  maxPdfBytes: 10 * 1024 * 1024,
  messageFields: 'id,internalDate,payload(headers(name,value),' + nest(4) + ')',
} }];`;

const validateConfig = String.raw`const cfg = $('Configuracion').first().json;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!email.test(cfg.mailbox)) throw new Error('Falta BUZON_AUTORIZADO: no se llamó a Google.');
if (cfg.allowedSenders.length === 0 || !cfg.allowedSenders.every((s) => email.test(s))) {
  throw new Error('Falta REMITENTES_AUTORIZADOS: no se llamó a Google.');
}
if (!/^[a-z0-9-]+$/.test(cfg.label)) throw new Error('La etiqueta no es válida: no se llamó a Google.');
// Nunca toda la bandeja: etiqueta, adjunto PDF, remitente y antigüedad, todos obligatorios.
const query = 'label:' + cfg.label + ' has:attachment filename:pdf newer_than:30d from:(' + cfg.allowedSenders.join(' OR ') + ')';
return [{ json: { query } }];`;

const verifyMailbox = String.raw`const cfg = $('Configuracion').first().json;
const actual = String($input.first().json.emailAddress ?? '').trim().toLowerCase();
if (actual === '' || actual !== cfg.mailbox) {
  throw new Error('La credencial OAuth no corresponde al buzón autorizado. No se leyó ningún mensaje.');
}
return [{ json: { mailbox: actual, query: $('Validar configuracion').first().json.query } }];`;

const gmailFailure = String.raw`// Mensaje fijo: el error original no se copia para no arrastrar datos de la solicitud.
const detail = $input.first().json.error ?? $input.first().json;
const code = Number(detail?.httpCode ?? /^(\d{3})\b/.exec(String(detail?.cause?.message ?? detail?.message ?? ''))?.[1] ?? 0);
const needsReconnect = /reconnected|invalid_grant/i.test(String(detail?.message ?? '') + String(detail?.description ?? '') + String(detail?.cause?.message ?? ''));
const reason = needsReconnect ? 'la credencial debe reconectarse en n8n: su autorización se revocó o venció (en modo Testing de Google, a los 7 días)'
  : code === 401 ? 'la credencial OAuth fue rechazada o revocada (401)'
  : code === 403 ? 'la credencial no tiene permiso de lectura, o se alcanzó un límite (403)'
    : code === 429 ? 'se alcanzó un límite de Gmail (429)'
      : 'Gmail no respondió correctamente' + (code ? ' (HTTP ' + code + ')' : '');
throw new Error('Gmail: ' + reason + '. No se registró nada; reejecutar es seguro.');`;

const prepareMessages = String.raw`const messages = $input.first().json.messages ?? [];
return messages.map((m) => ({ json: { messageId: m.id } }));`;

const extract = String.raw`const cfg = $('Configuracion').first().json;
const pending = $('Preparar mensajes').all();

const header = (msg, name) => (msg.payload?.headers ?? []).find((h) => String(h.name).toLowerCase() === name)?.value ?? '';
const senderOf = (from) => (/<([^<>]+)>\s*$/.exec(from)?.[1] ?? from).trim().toLowerCase();
// No se entra en mensajes reenviados: lo que traen dentro está fuera del alcance.
function collect(part, found = []) {
  if (part.filename) found.push(part);
  if (part.mimeType !== 'message/rfc822') for (const child of part.parts ?? []) collect(child, found);
  return found;
}

const out = [];
$input.all().forEach((item, i) => {
  const messageId = pending[i].json.messageId;
  const msg = item.json.body;
  if (item.json.statusCode !== 200 || !msg?.payload) {
    out.push({ json: { messageId, outcome: 'error_gmail', httpStatus: item.json.statusCode ?? null } });
    return;
  }
  const from = header(msg, 'from');
  const base = { messageId, receivedAt: new Date(Number(msg.internalDate)).toISOString() };
  if (!cfg.allowedSenders.includes(senderOf(from))) {
    out.push({ json: { ...base, outcome: 'remitente_no_autorizado' } });
    return;
  }
  const seen = { ...base, from, subject: header(msg, 'subject') };
  const parts = collect(msg.payload);
  if (parts.length === 0) out.push({ json: { ...seen, outcome: 'sin_adjuntos' } });
  let accepted = 0;
  for (const p of parts) {
    const a = { ...seen, partId: p.partId, fileName: p.filename, mimeType: p.mimeType, size: p.body?.size ?? 0 };
    const isPdf = /\.pdf$/i.test(p.filename) && String(p.mimeType).toLowerCase() === 'application/pdf';
    if (!isPdf) out.push({ json: { ...a, outcome: 'tipo_no_admitido' } });
    else if (!p.body?.attachmentId) out.push({ json: { ...a, outcome: 'sin_identificador' } });
    else if (a.size > cfg.maxPdfBytes) out.push({ json: { ...a, outcome: 'demasiado_grande' } });
    else if (accepted >= cfg.maxAttachmentsPerMessage) out.push({ json: { ...a, outcome: 'limite_de_adjuntos' } });
    else {
      accepted += 1;
      out.push({ json: cfg.ingestAuthorized
        ? { ...a, attachmentId: p.body.attachmentId, download: true }
        : { ...a, outcome: 'pendiente_de_autorizacion' } });
    }
  }
});
return out;`;

const decode = String.raw`const wanted = $('Extraer adjuntos').all().filter((x) => x.json.download);
const mailbox = $('Verificar buzon').first().json.mailbox;
return $input.all().map((item, i) => {
  const { attachmentId, download, ...source } = wanted[i].json;
  const data = item.json.body?.data;
  if (item.json.statusCode !== 200 || typeof data !== 'string') {
    return { json: { ...source, outcome: 'error_gmail', httpStatus: item.json.statusCode ?? null } };
  }
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== source.size) {
    return { json: { ...source, outcome: 'error_gmail', httpStatus: null } };
  }
  return {
    json: { ...source, decoded: true, mailbox, runId: String($execution.id ?? 'manual').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) },
    binary: { data: { data: bytes.toString('base64'), mimeType: 'application/pdf', fileName: source.fileName, fileExtension: 'pdf' } },
  };
});`;

const classify = String.raw`const sent = $('Decodificar').all().filter((x) => x.json.decoded);
const OUTCOME = { 201: 'registrado', 200: 'ya_registrado', 400: 'rechazado', 413: 'rechazado', 415: 'rechazado', 401: 'token_rechazado', 403: 'buzon_no_vinculado', 409: 'conflicto' };
return $input.all().map((item, i) => {
  const { decoded, runId, mailbox, ...source } = sent[i].json;
  const status = item.json.statusCode ?? null;
  const body = status === 200 || status === 201 ? item.json.body : {};
  return { json: {
    ...source,
    outcome: OUTCOME[status] ?? 'error_temporal',
    httpStatus: status,
    documentId: body.documentId,
    caseId: body.caseId,
    duplicateContent: body.duplicateContent,
  } };
});`;

const summary = String.raw`const cfg = $('Configuracion').first().json;
const items = $input.all().map((x) => x.json);
const counts = {};
for (const x of items) counts[x.outcome] = (counts[x.outcome] ?? 0) + 1;
// Remitente y asunto solo se muestran en la revisión previa, y nunca a los no autorizados.
const detail = items.map(({ attachmentId, download, ...x }) => (cfg.ingestAuthorized ? { ...x, from: undefined, subject: undefined } : x));
const moreMessages = Boolean($('Listar mensajes').first().json.nextPageToken);
const FAILURES = ['error_gmail', 'error_temporal', 'token_rechazado', 'buzon_no_vinculado', 'conflicto'];
const failed = FAILURES.filter((f) => counts[f]);
if (failed.length > 0) {
  throw new Error('Recepción incompleta: ' + failed.map((f) => f + '=' + counts[f]).join(', ') + '. Reejecutar es seguro: lo ya registrado no se duplica.');
}
return [{ json: { modo: cfg.ingestAuthorized ? 'ingesta' : 'solo_revision', conteo: counts, hayMasMensajes: moreMessages, detalle: detail } }];`;

// ------------------------------------------------------------------ nodos
let seq = 0;
const nid = () => { seq += 1; return `7a2c3b50-${String(seq).padStart(4, '0')}-4b00-8b00-${String(seq).padStart(12, '0')}`; };
const pos = (x, y = 0) => [x * 220, y];
const code = (name, x, y, jsCode, extra = {}) => ({ id: nid(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y), parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode }, ...extra });
const gate = (name, x, y, left) => ({
  id: nid(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos(x, y),
  parameters: { options: {}, conditions: { options: { version: 2, caseSensitive: true, leftValue: '', typeValidation: 'strict' }, combinator: 'and', conditions: [{ id: nid(), leftValue: left, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }] } },
});
const gmailGet = (name, x, y, url, query, extra = {}, options = {}) => ({
  id: nid(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(x, y), credentials: GMAIL_CRED,
  parameters: {
    method: 'GET', url, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api',
    sendQuery: true, queryParameters: { parameters: query },
    options: { timeout: 60000, ...options },
  },
  ...extra,
});
// n8n envía los ítems en paralelo; el intervalo (debe ser > 0) los espacia.
const paced = (batchInterval) => ({ batching: { batch: { batchSize: 1, batchInterval } }, response: { response: { neverError: true, fullResponse: true } } });
const PER_ITEM = paced(250);
// El backend admite 2 subidas simultáneas. Si aun así responde 429, queda como
// fallo temporal y reejecutar es seguro.
const PER_UPLOAD = paced(2000);
const CFG = "$('Configuracion').first().json";
const retried = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueErrorOutput', notes: 'Solo lectura. Reintenta fallos pasajeros; un fallo definitivo detiene la ejecución sin registrar nada.' };

const nodes = [
  { id: nid(), name: 'Ejecucion manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: pos(0), parameters: {} },
  { id: nid(), name: 'Disparo programado', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: pos(0, -260), notes: 'Cada 15 min mientras el workflow esté ACTIVO. Inactivo por defecto: activarlo requiere autorización.', parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } },
  code('Marcar programado', 0.5, -260, '// Marca la ejecución como programada para la Configuracion.\nreturn [{ json: { scheduled: true } }];'),
  code('Configuracion', 1, 0, config, { notes: 'Interruptores y alcance autorizado. En false no se llama a Google ni al backend.' }),
  gate('Lectura autorizada?', 2, 0, `={{ ${CFG}.readAuthorized }}`),
  { id: nid(), name: 'Detenido: sin autorizacion', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: pos(3, 300), parameters: {} },
  code('Validar configuracion', 3, 0, validateConfig),
  gmailGet('Perfil de Gmail', 4, 0, `={{ ${CFG}.gmailBase }}/gmail/v1/users/me/profile`, [{ name: 'fields', value: 'emailAddress' }], retried),
  code('Fallo de Gmail', 5, 500, gmailFailure),
  code('Verificar buzon', 5, 0, verifyMailbox),
  gate('Ingesta autorizada?', 6, 0, `={{ ${CFG}.ingestAuthorized }}`),
  { id: nid(), name: 'Health', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(7, -200), retryOnFail: true, maxTries: 5, waitBetweenTries: 5000, notes: 'Despierta Render antes de leer el correo.', parameters: { method: 'GET', url: `={{ ${CFG}.apiBase }}/health`, options: { timeout: 90000 } } },
  { id: nid(), name: 'Readiness', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(8, -200), retryOnFail: true, maxTries: 5, waitBetweenTries: 5000, parameters: { method: 'GET', url: `={{ ${CFG}.apiBase }}/health/ready`, options: { timeout: 90000 } } },
  gmailGet('Listar mensajes', 9, 0, `={{ ${CFG}.gmailBase }}/gmail/v1/users/me/messages`, [
    { name: 'q', value: "={{ $('Verificar buzon').first().json.query }}" },
    { name: 'maxResults', value: `={{ ${CFG}.maxMessages }}` },
    { name: 'fields', value: 'messages/id,nextPageToken' },
  ], retried),
  code('Preparar mensajes', 10, 0, prepareMessages),
  gmailGet('Leer mensaje', 11, 0, `={{ ${CFG}.gmailBase }}/gmail/v1/users/me/messages/{{ $json.messageId }}`, [
    { name: 'format', value: 'full' },
    { name: 'fields', value: `={{ ${CFG}.messageFields }}` },
  ], { onError: 'continueRegularOutput', notes: 'Un fallo no detiene los demás mensajes: se informa al final y reejecutar es seguro.' }, PER_ITEM),
  code('Extraer adjuntos', 12, 0, extract),
  gate('Descargable?', 13, 0, '={{ $json.download === true }}'),
  gmailGet('Descargar adjunto', 14, 0, `={{ ${CFG}.gmailBase }}/gmail/v1/users/me/messages/{{ $json.messageId }}/attachments/{{ $json.attachmentId }}`, [
    { name: 'fields', value: 'data,size' },
  ], { onError: 'continueRegularOutput' }, PER_ITEM),
  code('Decodificar', 15, 0, decode),
  gate('Decodificado?', 16, 0, '={{ $json.decoded === true }}'),
  {
    id: nid(), name: 'Enviar al backend', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(17), credentials: API_CRED,
    onError: 'continueRegularOutput',
    notes: 'Seguro de repetir: buzón + mensaje + parte no crea un segundo documento. El backend decide propietario y validez del PDF.',
    parameters: {
      method: 'POST', url: `={{ ${CFG}.apiBase }}/internal/gmail/attachments`,
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'multipart-form-data',
      bodyParameters: { parameters: [
        { parameterType: 'formData', name: 'mailbox', value: '={{ $json.mailbox }}' },
        { parameterType: 'formData', name: 'messageId', value: '={{ $json.messageId }}' },
        { parameterType: 'formData', name: 'partId', value: '={{ $json.partId }}' },
        { parameterType: 'formData', name: 'receivedAt', value: '={{ $json.receivedAt }}' },
        { parameterType: 'formData', name: 'workflowRunId', value: '={{ $json.runId }}' },
        { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
      ] },
      options: { timeout: 120000, ...PER_UPLOAD },
    },
  },
  code('Clasificar envio', 18, 0, classify),
  { id: nid(), name: 'Reunir resultados', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: pos(19, 200), parameters: { mode: 'append', numberInputs: 3 } },
  code('Resumen', 20, 200, summary),
];

const link = (name, index = 0, type = 'main') => ({ node: name, type, index });
const connections = {
  'Ejecucion manual': { main: [[link('Configuracion')]] },
  'Disparo programado': { main: [[link('Marcar programado')]] },
  'Marcar programado': { main: [[link('Configuracion')]] },
  Configuracion: { main: [[link('Lectura autorizada?')]] },
  'Lectura autorizada?': { main: [[link('Validar configuracion')], [link('Detenido: sin autorizacion')]] },
  'Validar configuracion': { main: [[link('Perfil de Gmail')]] },
  'Perfil de Gmail': { main: [[link('Verificar buzon')], [link('Fallo de Gmail')]] },
  'Verificar buzon': { main: [[link('Ingesta autorizada?')]] },
  'Ingesta autorizada?': { main: [[link('Health')], [link('Listar mensajes')]] },
  Health: { main: [[link('Readiness')]] },
  Readiness: { main: [[link('Listar mensajes')]] },
  'Listar mensajes': { main: [[link('Preparar mensajes')], [link('Fallo de Gmail')]] },
  'Preparar mensajes': { main: [[link('Leer mensaje')]] },
  'Leer mensaje': { main: [[link('Extraer adjuntos')]] },
  'Extraer adjuntos': { main: [[link('Descargable?')]] },
  'Descargable?': { main: [[link('Descargar adjunto')], [link('Reunir resultados', 2)]] },
  'Descargar adjunto': { main: [[link('Decodificar')]] },
  Decodificar: { main: [[link('Decodificado?')]] },
  'Decodificado?': { main: [[link('Enviar al backend')], [link('Reunir resultados', 1)]] },
  'Enviar al backend': { main: [[link('Clasificar envio')]] },
  'Clasificar envio': { main: [[link('Reunir resultados', 0)]] },
  'Reunir resultados': { main: [[link('Resumen')]] },
};

const workflow = {
  id: 'nhpGmailIngest01',
  name: 'NotiHouse-Pal - 05 - Recepcion de facturas por Gmail',
  active: false,
  isArchived: false,
  // No guarda datos de ejecución: evita conservar remitentes, asuntos o adjuntos en n8n.
  settings: { executionOrder: 'v1', saveManualExecutions: false, saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveExecutionProgress: false },
  pinData: {},
  tags: [],
  nodes,
  connections,
};
writeFileSync(OUT, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`${OUT} (${nodes.length} nodos)`);
