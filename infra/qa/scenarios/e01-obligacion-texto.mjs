/** Escenario 1 (API) — Obligación por texto: mensaje -> caso -> trabajo -> n8n 04 -> resolve -> propuesta -> HITL -> aprobar -> aplicar -> 03.
 *  (La misma ruta se verificó también por la interfaz.) Gemini SIMULADO; todo lo demás real. */
import { login, http, sql, close, n8nRun, assert, textThroughN8n, decide, apply, WF03 } from '../lib.mjs';
const t = await login('DANIEL');
const r0 = await sql("select count(*)::int n from obligations where provider_name='Tigo'");
const x = await textThroughN8n(t, 'Registra Tigo internet, vence el día 10 de cada mes, avísame 2 días antes');
assert(x.caseStatus === 'awaiting_human', `caso en awaiting_human (${x.caseStatus})`);
assert(x.proposal?.source === 'llm' && x.proposal.proposed_data.action === 'create_recurring_obligation', `propuesta llm create_recurring_obligation (${x.proposal?.proposed_data?.action})`);
assert(x.hitl?.decision_type === 'data_confirmation' && x.hitl.status === 'pending', 'revisión data_confirmation pendiente');
assert(Number((await sql("select count(*)::int n from obligations where provider_name='Tigo'"))[0].n) === r0[0].n, 'antes de aprobar no existe la obligación');
assert([200, 201].includes((await decide(t, x.hitl.id)).status), 'aprobación humana');
assert(Number((await sql("select count(*)::int n from obligations where provider_name='Tigo'"))[0].n) === r0[0].n, 'aprobar ≠ aplicar: sigue sin existir');
assert([200, 201].includes((await apply(t, x.caseId, x.proposal.id)).status), 'aplicación explícita');
const o = (await sql("select due_day, reminder_days_before, auto_generate, frequency::text f from obligations where provider_name='Tigo'"))[0];
assert(o && o.due_day === 10 && o.reminder_days_before === 2 && o.auto_generate === true && o.f === 'monthly', `obligación creada: día ${o?.due_day}, aviso ${o?.reminder_days_before}, auto ${o?.auto_generate}`);
const per = await sql("select oc.due_date::text d from obligation_occurrences oc join obligations ob on ob.id=oc.obligation_id where ob.provider_name='Tigo' order by 1");
assert(per.length === 2 && per[0].d === '2026-11-10', `primer período visible (${per.map((p) => p.d)})`);
n8nRun(WF03);
assert((await sql('select status from cases where id=$1', [x.caseId]))[0].status === 'completed', 'workflow 03 cierra el caso (completed)');
const aud = (await sql("select action from audit_events where action in ('case_proposal.accept','case_proposal.apply','hitl_request.approve')")).map((a) => a.action);
assert(aud.length >= 3, `auditoría de aprobación y aplicación (${aud})`);
await close();
