/**
 * Escenario 14 — Estados de error de la IA vistos por el usuario (Fase 1 del cierre del MVP).
 * Gemini SIMULADO (mock-gemini.mjs) + workflows 04 reales en n8n QA. Comprueba, por cada fallo, el ESTADO REAL
 * que ve el frontend (caso, razón, trabajo) y que nunca queda un caso «procesando» para siempre ni se duplican registros.
 * Datos ficticios; cuentas de la base QA.
 */
import { login, http, sql, close, assert, textThroughN8n, drainQueue, mock, n8nRun, WF04, decide, closeCase, killSwitch } from '../lib.mjs';

const t = await login('ANDRES');
const clean = async () => {
  await drainQueue();
  for (const h of await sql("select h.id::text from hitl_requests h join auth_accounts a on a.profile_id=h.owner_id where a.email=$1 and h.status='pending'", [process.env.QA_USER_EMAIL_ANDRES])) await decide(t, h.id, 'rejected', 'limpieza QA');
  for (const c of await sql("select c.id::text id from cases c join auth_accounts a on a.profile_id=c.owner_id where a.email=$1 and c.status in ('processing','awaiting_human','received')", [process.env.QA_USER_EMAIL_ANDRES])) await closeCase(c.id);
};
const rows = async (caseId) => ({
  caso: (await sql('select status::text, status_reason from cases where id=$1', [caseId]))[0],
  job: (await sql("select status::text, attempts, last_error from workflow_jobs where case_id=$1 and job_type='text.interpret' order by created_at desc limit 1", [caseId]))[0],
});
const show = (label, r) => console.log(`   · ${label}: caso=${r.caso?.status} razón=${JSON.stringify(r.caso?.status_reason)} trabajo=${r.job?.status}/${r.job?.attempts} error=${JSON.stringify(r.job?.last_error)}`);

async function run(label, control, text = 'Registra la factura de agua de Acueducto por 98.500 pesos') {
  await clean();
  await mock('/__control', control);
  const x = await textThroughN8n(t, text);
  const r = await rows(x.caseId);
  show(label, r);
  return { x, r };
}

for (const code of [429, 500, 503]) {
  const { x, r } = await run(`Gemini ${code}`, { failNext: code, failSkip: 1 });
  assert(!['received'].includes(r.caso.status), `Gemini ${code}: el caso no queda «recibido» sin más (${r.caso.status})`);
  assert(!/gemini|n8n|workflow|\bjson\b|http|stack/i.test(r.caso.status_reason ?? ''), `Gemini ${code}: la razón visible no filtra tecnicismos (${r.caso.status_reason})`);
  if (r.caso.status === 'failed') assert(Boolean(r.caso.status_reason), `Gemini ${code}: caso fallido con razón (${r.caso.status_reason})`);
  void x;
}
const inv = await run('JSON inválido', { failNext: 'invalid_json', failSkip: 1 });
assert(inv.r.caso.status !== 'awaiting_human' || !inv.x.proposal?.proposed_data?.action, `JSON inválido: no se inventa una propuesta aplicable (${inv.r.caso.status})`);
const emp = await run('Respuesta vacía', { failNext: 'empty', failSkip: 1 });
assert(emp.r.caso.status !== 'awaiting_human' || !emp.x.proposal?.proposed_data?.action, `Respuesta vacía: no se inventa una propuesta (${emp.r.caso.status})`);
const unk = await run('Intención desconocida', { nextInterpretation: { intent: 'hackear_sistema', providerName: null, containsInstructions: false, missing: [], ambiguities: [], evidence: [] }, failSkip: 1 });
assert(!unk.x.proposal?.proposed_data?.action, `Intención desconocida: sin propuesta aplicable (${unk.r.caso.status})`);

// Mensaje no comprendido (el simulado responde unsupported)
const uns = await run('Solicitud no comprendida', {}, 'blablabla qué hora es en Marte');
assert(!uns.x.proposal?.proposed_data?.action, `No comprendida: sin propuesta aplicable (${JSON.stringify(uns.x.proposal?.proposed_data?.resultado)})`);

// ---- Fallo PERSISTENTE (se rearma antes de cada ejecución de n8n): el trabajo agota sus intentos
async function persistent(label, mode) {
  await clean();
  const r = await http('POST', '/ingestions/text', { token: t, body: { text: 'Registra la factura de agua de Acueducto por 98.500 pesos' } });
  const caseId = r.body.caseId;
  // Fallo transitorio con reintentos pendientes: el caso sigue «procesando» (con espera entre intentos).
  await mock('/__control', { failNext: mode, failSkip: 1 });
  n8nRun(WF04);
  const mid = await rows(caseId);
  show(label + ' (1.er intento)', mid);
  assert(mid.caso.status === 'processing' && mid.job?.status === 'pending', `${label}: tras el 1.er fallo se reintenta (el caso sigue «procesando», no «fallido») (${mid.caso.status}/${mid.job?.status})`);
  // Último intento: se agotan los reintentos (en QA se adelanta el contador; el backend decide el cierre).
  await sql("update workflow_jobs set attempts = max_attempts - 1, available_at = now() where case_id=$1 and job_type='text.interpret'", [caseId]);
  await mock('/__control', { failNext: mode, failSkip: 1 });
  n8nRun(WF04);
  await mock('/__control', { failNext: null, failSkip: 0 });
  const rr = await rows(caseId);
  show(label, rr);
  const api = (await http('GET', `/cases/${caseId}`, { token: t })).body;
  console.log(`   · API caso: status=${api.status} statusReason=${JSON.stringify(api.statusReason)}`);
  assert(['failed', 'cancelled'].includes(rr.caso.status), `${label}: agotados los intentos el caso queda «failed», no colgado (${rr.caso.status}/${rr.job?.status})`);
  assert(Boolean(rr.caso.status_reason), `${label}: el caso explica la causa (${rr.caso.status_reason})`);
  assert(!/gemini|n8n|workflow|json|stack|http \d|\bapi\b/i.test(rr.caso.status_reason ?? ''), `${label}: razón sin tecnicismos crudos (${rr.caso.status_reason})`);
  return { caseId, rr };
}
await persistent('Gemini 429 persistente', 429);
await persistent('Gemini 503 persistente', 503);
await persistent('JSON inválido persistente', 'invalid_json');

await mock('/__control', { failNext: null, failSkip: 0 });
for (const h of await sql("select h.id::text from hitl_requests h join auth_accounts a on a.profile_id=h.owner_id where a.email=$1 and h.status='pending'", [process.env.QA_USER_EMAIL_ANDRES])) await decide(t, h.id, 'rejected', 'limpieza QA');
await drainQueue();
void closeCase;
const ks = killSwitch('resume', '--scope', 'text_processing', '--operator', 'qa-e14', '--reason', 'QA e14 fin de pruebas de fallo', '--test-evidence', 'e14 fallos simulados');
console.log('   · kill switch text_processing reanudado:', ks.status === 0 ? 'ok' : ks.out.slice(0, 120));
await close();
