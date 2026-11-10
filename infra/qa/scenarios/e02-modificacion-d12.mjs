/**
 * Escenario 2 — Modificación por texto + A-5 (factura sobre período ya generado) + D12.
 * Integración local: PG18 real, NestJS real, n8n real (workflows 04 y 03). Gemini SIMULADO.
 */
import { login, http, sql, close, n8nRun, assert, textThroughN8n, decide, apply, WF03 } from '../lib.mjs';
const t = await login('DANIEL');
const occ = async (period) => (await sql("select oc.due_date::text d, oc.amount::text a from obligation_occurrences oc join obligations o on o.id=oc.obligation_id where o.provider_name='Tigo' and oc.period_start=$1", [period]))[0];

// --- A-5: llega una factura de Tigo del mes con otra fecha de vencimiento -> update_occurrence_details
const inv = await textThroughN8n(t, 'Me llegó la factura de Tigo por 120.000 pesos, vence el 25 de noviembre de 2026');
assert(inv.hitl?.decision_type === 'data_confirmation', `factura sobre período existente: HITL data_confirmation (${inv.hitl?.decision_type})`);
assert(inv.proposal?.proposed_data?.action === 'update_occurrence_details', `acción propuesta = update_occurrence_details (${inv.proposal?.proposed_data?.action})`);
const before = await occ('2026-11-01');
assert(before.d === '2026-11-10', `antes de aplicar, el vencimiento de noviembre sigue en 2026-11-10 (${before.d}) — nada se escribió sin aprobación`);
let d = await decide(t, inv.hitl.id); assert(d.status === 200 || d.status === 201, `aprobación humana (${d.status})`);
assert((await occ('2026-11-01')).d === '2026-11-10', 'aprobar NO modifica el período');
let a = await apply(t, inv.caseId, inv.proposal.id); assert(a.status === 200 || a.status === 201, `aplicación explícita (${a.status})`);
const afterInv = await occ('2026-11-01');
assert(afterInv.d === '2026-11-25' && afterInv.a === '120000.00', `período actualizado: ${afterInv.d} / ${afterInv.a}`);
let a2 = await apply(t, inv.caseId, inv.proposal.id);
assert(a2.status === 200 && a2.body?.alreadyApplied === true, `reaplicar es idempotente (${a2.status}, alreadyApplied=${a2.body?.alreadyApplied})`);

// --- Escenario 2: cambiar el día de vencimiento habitual
const upd = await textThroughN8n(t, 'Cambia el vencimiento de Tigo al día 20');
assert(upd.proposal?.proposed_data?.action === 'update_obligation_schedule', `acción propuesta = update_obligation_schedule (${upd.proposal?.proposed_data?.action})`);
const pd = upd.proposal?.proposed_data?.data ?? {};
console.log('  diff propuesto:', JSON.stringify({ expected: pd.expected, changes: pd.changes }));
assert(pd.expected && pd.changes, 'la propuesta trae el estado esperado (antes) y los cambios (después)');
await decide(t, upd.hitl.id); await apply(t, upd.caseId, upd.proposal.id);
const ob = (await sql("select due_day from obligations where provider_name='Tigo'"))[0];
assert(ob.due_day === 20, `due_day de la obligación = 20 (${ob.due_day})`);
const nov = await occ('2026-11-01'); const dec = await occ('2026-12-01');
assert(nov.d === '2026-11-25', `D12: la fecha propia de la factura (25-nov) NO se sobrescribe (${nov.d})`);
assert(dec.d === '2026-12-20', `el período sin fecha propia sí sigue el nuevo día (${dec.d})`);

// --- A-6: el workflow 03 cierra ambos casos
n8nRun(WF03); n8nRun(WF03);
const st = await sql("select status from cases where id = any($1)", [[inv.caseId, upd.caseId]]);
assert(st.every((r) => r.status === 'completed'), `workflow 03 cerró los dos casos (${st.map((r) => r.status)})`);
await close();
