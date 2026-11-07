/**
 * Genera n8n/workflows/06-mantenimiento-programado.json (Etapa 7).
 * Único scheduler de reglas determinísticas: vence revisiones HITL (cada
 * ejecución) y evalúa alertas internas (como máximo una vez por hora). No usa
 * IA, no envía notificaciones externas y nunca aprueba por silencio.
 * Uso: node n8n/tests/build-workflow-06.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../workflows/06-mantenimiento-programado.json');
const API_CRED = { httpHeaderAuth: { id: 'nhpApiService001', name: 'NotiHouse-Pal API (servicio)' } };

const config = String.raw`// ÚNICO interruptor de llamadas al backend. Con false no se llama a nada.
const AUTORIZAR_MANTENIMIENTO = false;
// Ejecución PROGRAMADA (cada 15 min). Exige además el interruptor anterior.
const AUTOMATIZACION_PROGRAMADA = false;

const scheduled = $input.first()?.json?.scheduled === true;
// Un único evaluador de alertas, como máximo una vez por hora (contrato del
// backend). La ejecución manual siempre evalúa.
const ALERTS_EVERY_MS = 55 * 60 * 1000;
let lastAlertsAt = 0;
try { lastAlertsAt = Number($getWorkflowStaticData('global').lastAlertsAt ?? 0); } catch { /* sin datos estáticos */ }

return [{ json: {
  authorized: AUTORIZAR_MANTENIMIENTO === true && (!scheduled || AUTOMATIZACION_PROGRAMADA === true),
  scheduled,
  runAlerts: !scheduled || Date.now() - lastAlertsAt >= ALERTS_EVERY_MS,
  lastAlertsAt: lastAlertsAt ? new Date(lastAlertsAt).toISOString() : null,
  apiBase: 'https://notihouse-pal-api.onrender.com/api/v1',
  workerId: 'n8n-scheduler',
  maxEvaluationRounds: 20,
} }];`;

const record = String.raw`const r = $input.first().json;
try { $getWorkflowStaticData('global').lastAlertsAt = Date.now(); } catch { /* ejecución manual */ }
return [{ json: {
  evaluationDate: r.evaluationDate,
  created: r.created, reactivated: r.reactivated, resolved: r.resolved, unchanged: r.unchanged,
  correlationId: r.correlationId,
} }];`;

const classify = String.raw`const item = $input.first().json;
const step = $prevNode.name;
const detail = item.error ?? item;
const text = JSON.stringify(item);
const code = Number(detail?.httpCode ?? /^(\d{3})\b/.exec(String(detail?.cause?.message ?? detail?.message ?? ''))?.[1] ?? 0);
const killSwitch = /KILL_SWITCH_ACTIVE/.test(text) || code === 503;
// Mensajes fijos: nunca se copia la respuesta (no hay secretos en ella, pero
// tampoco aporta nada a quien opera).
const message = killSwitch
  ? 'Kill switch activo o backend no disponible (503) en "' + step + '": mantenimiento detenido sin escribir nada.'
  : code === 401
    ? 'Token de servicio rechazado (401): revisa la credencial.'
    : 'Fallo en "' + step + '"' + (code ? ' (HTTP ' + code + ')' : '') + '. Se reintentará en la siguiente ejecución programada.';
return [{ json: { message } }];`;

let seq = 0;
const nid = () => { seq += 1; return `7a2c3b60-${String(seq).padStart(4, '0')}-4b00-8b00-${String(seq).padStart(12, '0')}`; };
const pos = (x, y = 0) => [x * 220, y];
const code = (name, x, y, jsCode, extra = {}) => ({ id: nid(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos(x, y), parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode }, ...extra });
const gate = (name, x, y, left) => ({
  id: nid(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos(x, y),
  parameters: { options: {}, conditions: { options: { version: 2, caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and', conditions: [{ id: nid(), leftValue: left, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }] } },
});
const CFG = "$('Configuracion').first().json";
const post = (name, x, path, body) => ({
  id: nid(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(x), credentials: API_CRED,
  onError: 'continueErrorOutput',
  parameters: {
    method: 'POST', url: `={{ ${CFG}.apiBase }}${path}`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: body,
    options: { timeout: 120000 },
  },
});

const nodes = [
  { id: nid(), name: 'Ejecucion manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: pos(0), parameters: {} },
  { id: nid(), name: 'Disparo programado', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: pos(0, -260), notes: 'Cada 15 min mientras el workflow esté ACTIVO. Inactivo por defecto: activarlo requiere autorización.', parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } },
  code('Marcar programado', 0.5, -260, '// Marca la ejecución como programada para la Configuracion.\nreturn [{ json: { scheduled: true } }];'),
  code('Configuracion', 1, 0, config, { notes: 'Interruptores. En false no se llama al backend.' }),
  gate('Autorizado?', 2, 0, '={{ $json.authorized }}'),
  { id: nid(), name: 'Detenido: sin autorizacion', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: pos(3, 260), parameters: {} },
  { id: nid(), name: 'Health', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(3), retryOnFail: true, maxTries: 5, waitBetweenTries: 5000, notes: 'Despierta Render (plan gratuito).', parameters: { method: 'GET', url: `={{ ${CFG}.apiBase }}/health`, options: { timeout: 90000 } } },
  { id: nid(), name: 'Readiness', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(4), retryOnFail: true, maxTries: 5, waitBetweenTries: 5000, parameters: { method: 'GET', url: `={{ ${CFG}.apiBase }}/health/ready`, options: { timeout: 90000 } } },
  post('Vencer revisiones', 5, '/internal/hitl-requests/expire', `={{ JSON.stringify({ workerId: ${CFG}.workerId, limit: 100 }) }}`),
  gate('Evaluar alertas?', 6, 0, `={{ ${CFG}.runAlerts }}`),
  { id: nid(), name: 'Alertas: esperar a la proxima hora', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: pos(7, 260), parameters: {} },
  post('Evaluar alertas', 7, '/internal/alerts/evaluate', `={{ JSON.stringify({ workerId: ${CFG}.workerId, ...($json.nextCursor ? { cursor: $json.nextCursor } : {}) }) }}`),
  gate('Evaluacion incompleta?', 8, 0, `={{ $json.complete === false && $runIndex < ${CFG}.maxEvaluationRounds }}`),
  code('Registrar evaluacion', 9, 0, record),
  code('Clasificar fallo', 6, 500, classify),
  { id: nid(), name: 'Terminar con error', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: pos(7, 500), parameters: { errorMessage: "={{ $json.message }}" } },
];

const link = (name, index = 0) => ({ node: name, type: 'main', index });
const connections = {
  'Ejecucion manual': { main: [[link('Configuracion')]] },
  'Disparo programado': { main: [[link('Marcar programado')]] },
  'Marcar programado': { main: [[link('Configuracion')]] },
  Configuracion: { main: [[link('Autorizado?')]] },
  'Autorizado?': { main: [[link('Health')], [link('Detenido: sin autorizacion')]] },
  Health: { main: [[link('Readiness')]] },
  Readiness: { main: [[link('Vencer revisiones')]] },
  'Vencer revisiones': { main: [[link('Evaluar alertas?')], [link('Clasificar fallo')]] },
  'Evaluar alertas?': { main: [[link('Evaluar alertas')], [link('Alertas: esperar a la proxima hora')]] },
  'Evaluar alertas': { main: [[link('Evaluacion incompleta?')], [link('Clasificar fallo')]] },
  'Evaluacion incompleta?': { main: [[link('Evaluar alertas')], [link('Registrar evaluacion')]] },
  'Clasificar fallo': { main: [[link('Terminar con error')]] },
};

const workflow = {
  id: 'nhpMaintSched001',
  name: 'NotiHouse-Pal - 06 - Mantenimiento programado (alertas y vencimientos HITL)',
  active: false,
  isArchived: false,
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveManualExecutions: true },
  pinData: {},
  tags: [],
  nodes,
  connections,
};
writeFileSync(OUT, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`${OUT} (${nodes.length} nodos)`);
