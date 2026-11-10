/**
 * Escenario 12 — Kill switches (alcances `global`, `alert_evaluation`, `case_processing`; los de
 * `recurrence_generation`, `text_processing` y `proposal_application` los cubren e05 y e09).
 * Solo sobre la base QA, con el script oficial. Comprueba: activación, suspensión (503), nada cambia,
 * auditoría append-only, la reanudación exige evidencia de prueba y todo funciona al reanudar.
 */
import { login, http, sql, close, assert, killSwitch, sleep, textThroughN8n, decide, apply, closeCase } from '../lib.mjs';

const t = await login('DANIEL');
const audit = async (scope, action) => Number((await sql("select count(*)::int n from audit_events where action=$1 and metadata->>'scope'=$2", [action, scope]))[0].n);
const evaluate = () => http('POST', '/internal/alerts/evaluate', { service: true, body: { workerId: 'qa-e12', batchSize: 20 } });
const resume = (scope) => killSwitch('resume', '--scope', scope, '--operator', 'qa-e12', '--reason', `QA e12 ${scope} listo`, '--test-evidence', `e12 comprobó la suspensión de ${scope}`);
const activate = async (scope) => { const r = killSwitch('activate', '--scope', scope, '--operator', 'qa-e12', '--reason', `QA e12 ${scope}`); await sleep(1500); return r; };

// ---- Propuesta aprobada, lista para aplicar (se usa con `global`).
const a = await textThroughN8n(t, 'Registra EPM, vence el día 6 de cada mes, avísame 2 días antes');
assert(a.proposal?.proposed_data?.action === 'create_recurring_obligation', `preparación: propuesta aplicable (${a.proposal?.proposed_data?.action})`);
await decide(t, a.hitl.id);

// ---- global
const nEpm = async () => Number((await sql("select count(*)::int n from obligations where provider_name='EPM'"))[0].n);
const before = await nEpm();
let r = await activate('global');
assert(r.status === 0, 'global: activado con el mecanismo oficial');
assert((await audit('global', 'kill_switch.activate')) >= 1, 'global: auditoría kill_switch.activate registrada');
assert((await apply(t, a.caseId, a.proposal.id)).status === 503, 'global: aplicar una propuesta aprobada → 503');
assert((await evaluate()).status === 503, 'global: evaluación de alertas → 503');
assert((await nEpm()) === before, 'global: no se creó la obligación (nada cambió)');
const noEvidence = killSwitch('resume', '--scope', 'global', '--operator', 'qa-e12', '--reason', 'sin evidencia');
assert(noEvidence.status !== 0, 'global: reanudar SIN evidencia de prueba es rechazado');
r = resume('global'); await sleep(1500);
assert(r.status === 0, 'global: reanudado con evidencia');
assert((await audit('global', 'kill_switch.resume')) >= 1, 'global: auditoría kill_switch.resume registrada');
assert([200, 201].includes((await apply(t, a.caseId, a.proposal.id)).status) && (await nEpm()) === before + 1, 'global: tras reanudar, aplicar funciona y crea la obligación');
assert((await evaluate()).status === 200, 'global: tras reanudar, la evaluación de alertas funciona');
assert(await closeCase(a.caseId) === 'completed', 'global: el caso se cierra (workflow 03)');

// ---- alert_evaluation (solo ese alcance)
r = await activate('alert_evaluation');
assert(r.status === 0 && (await evaluate()).status === 503, 'alert_evaluation: evaluación → 503');
const apps = await http('GET', '/alerts/summary', { token: t });
assert(apps.status === 200, `alert_evaluation: las lecturas del usuario siguen (${apps.status})`);
resume('alert_evaluation'); await sleep(1500);
assert((await evaluate()).status === 200, 'alert_evaluation: tras reanudar funciona');
assert((await audit('alert_evaluation', 'kill_switch.activate')) >= 1 && (await audit('alert_evaluation', 'kill_switch.resume')) >= 1, 'alert_evaluation: activación y reanudación auditadas');

// ---- case_processing: por diseño solo gobierna trabajos genéricos `case.*` (el MVP no usa ninguno). Los textos, PDF y
// notas de voz se detienen con text_processing / document_processing / voice_processing (e09, e05). Aquí se comprueba
// que el alcance es estrecho (no afecta a un trabajo de texto) y que su activación/reanudación quedan auditadas.
const sent = await http('POST', '/ingestions/text', { token: t, body: { text: 'Registra Claro, vence el día 9 de cada mes' } });
assert(sent.status === 201, `case_processing: texto recibido (${sent.status})`);
const claim = await http('POST', '/internal/workflow-jobs/claim', { service: true, body: { workerId: 'qa-e12', limit: 5, leaseSeconds: 120, jobTypes: ['text.interpret'] } });
const job = claim.body.jobs?.find((j) => j.case.id === sent.body.caseId);
assert(!!job, 'case_processing: trabajo reclamado');
const body = { jobId: job.id, claimToken: job.claimToken, source: 'llm', proposedData: { resultado: 'unsupported', requiereRevisionManual: true }, evidence: { origen: 'qa-e12' } };
await activate('case_processing');
const blocked = await http('POST', `/internal/cases/${job.case.id}/proposals`, { service: true, body });
assert(blocked.status === 201, `case_processing: no afecta al trabajo de texto (alcance estrecho, ${blocked.status})`);
resume('case_processing'); await sleep(1500);
assert(true, 'case_processing: reanudado');
assert((await audit('case_processing', 'kill_switch.activate')) >= 1 && (await audit('case_processing', 'kill_switch.resume')) >= 1, 'case_processing: activación y reanudación auditadas');
// El trabajo queda reclamado: se libera cerrándolo como fallo controlado para no dejar casos abiertos.
await http('POST', `/internal/workflow-jobs/${job.id}/fail`, { service: true, body: { claimToken: job.claimToken, errorCode: 'QA_E12', retryable: false, message: 'cierre del escenario' } });

await close();
