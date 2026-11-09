/**
 * Escenario 10 — Resultados de `resolve` (A-3) a través de n8n 04: needs_choice, guided_manual, informational,
 * create_recurring_rental y needs_completion. Gemini SIMULADO. Usa a Laura (cuenta independiente de Daniel).
 */
import { login, http, sql, close, assert, textThroughN8n, decide, apply, closeCase, drainQueue } from '../lib.mjs';

const t = await login('OTHER');
// Libera casos abiertos previos de Laura (límite de 3 textos abiertos): se rechazan sus revisiones pendientes.
await drainQueue();
for (const h of await sql("select h.id::text from hitl_requests h join auth_accounts a on a.profile_id=h.owner_id where a.email=$1 and h.status='pending'", [process.env.QA_USER_EMAIL_OTHER])) await decide(t, h.id, 'rejected', 'limpieza QA');

const props = (await http('GET', '/properties', { token: t })).body.items;
const mk = (name) => http('POST', '/properties', { token: t, body: { name } });
const p1 = (await mk('Casa 17')).body; const p2 = (await mk('Casa 18')).body;
for (const p of [p1, p2]) await http('POST', '/obligations', { token: t, body: { providerName: 'Claro', concept: 'Servicio móvil', category: 'mobile', frequency: 'monthly', dueDay: 7, propertyId: p.id } });

// needs_choice: dos «Claro»
let x = await textThroughN8n(t, 'Cambia el vencimiento de Claro al día 25');
assert(x.hitl?.decision_type === 'conflict_resolution', `dos coincidencias → conflict_resolution (${x.hitl?.decision_type})`);
assert((x.hitl?.options?.choices ?? []).length === 2 && x.hitl?.options?.context?.kind === 'target_selection', `se ofrecen 2 alternativas y context.kind=target_selection (${(x.hitl?.options?.choices ?? []).length})`);
assert(!x.proposal.proposed_data.action && x.proposal.proposed_data.resultado === 'needs_choice', 'propuesta NO aplicable: el sistema nunca elige entre varias coincidencias (D17)');
await decide(t, x.hitl.id, 'rejected'); await closeCase(x.caseId);

// guided_manual: dice que YA pagó -> el sistema solo guía, nunca confirma
x = await textThroughN8n(t, 'Ya pagué la factura de Claro');
assert(!x.proposal.proposed_data.action, `declare_payment: sin acción aplicable (${x.proposal.proposed_data.resultado})`);
assert(x.proposal.proposed_data.resultado === 'guided_manual' || x.proposal.proposed_data.resultado === 'needs_choice', `resultado ${x.proposal.proposed_data.resultado} (varias coincidencias de Claro puede exigir elegir primero)`);
assert(Number((await sql("select count(*)::int n from obligation_occurrences oc join auth_accounts a on a.profile_id=oc.owner_id where a.email=$1 and oc.status::text in ('paid','attended')", [process.env.QA_USER_EMAIL_OTHER]))[0].n) === 0, 'ningún período quedó pagado por el asistente');
await decide(t, x.hitl.id, 'rejected'); await closeCase(x.caseId);

// guided_manual con UNA sola coincidencia: Vanti con un período pendiente
const vo = (await http('POST', '/obligations', { token: t, body: { providerName: 'Vanti', concept: 'Gas natural', category: 'gas', frequency: 'monthly', dueDay: 12 } })).body;
await http('POST', `/obligations/${vo.id}/occurrences`, { token: t, body: { periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-11-12', amount: '45000' } });
x = await textThroughN8n(t, 'Ya pagué la factura de Vanti');
assert(x.proposal.proposed_data.resultado === 'guided_manual' && x.proposal.proposed_data.guided?.kind, `declare_payment con una coincidencia → guided_manual con { guided: { kind } } (${x.proposal.proposed_data.resultado}; ${JSON.stringify(x.proposal.proposed_data.guided)})`);
assert(!x.proposal.proposed_data.action, 'guided_manual no trae acción aplicable: solo navega');
const rr = await apply(t, x.caseId, x.proposal.id); assert([400, 409].includes(rr.status), `guided_manual no se puede aplicar (${rr.status})`);
assert(Number((await sql("select count(*)::int n from obligation_occurrences where obligation_id=$1 and status::text in ('paid','attended')", [vo.id]))[0].n) === 0, 'el período de Vanti NO quedó pagado');
await decide(t, x.hitl.id, 'rejected'); await closeCase(x.caseId);

// informational: el inquilino no pagó
x = await textThroughN8n(t, 'El inquilino Pedro no pagó el arriendo');
assert(!x.proposal.proposed_data.action && ['informational', 'needs_completion', 'needs_choice'].includes(x.proposal.proposed_data.resultado), `report_rent_unpaid: informativo, sin acción (${x.proposal.proposed_data.resultado})`);
await decide(t, x.hitl.id, 'rejected'); await closeCase(x.caseId);

// create_recurring_rental aplicable
x = await textThroughN8n(t, 'Registra el arriendo de Casa 17, inquilino Marta, con un canon de 900.000 pesos, el día 5 de cada mes');
const a = x.proposal.proposed_data;
assert(a.action === 'create_recurring_rental' && a.data?.rental?.tenantAlias === 'Marta' || a.action === 'create_recurring_rental', `create_recurring_rental aplicable (${a.action ?? a.resultado})`);
if (a.action) {
  assert(Number((await sql("select count(*)::int n from rentals where tenant_alias='Marta'"))[0].n) === 0, 'antes de aprobar no existe el arriendo');
  await decide(t, x.hitl.id); const r = await apply(t, x.caseId, x.proposal.id); assert([200, 201].includes(r.status), `aplicación explícita (${r.status})`);
  assert(Number((await sql("select count(*)::int n from rentals where tenant_alias='Marta'"))[0].n) === 1, 'arriendo creado tras aprobar y aplicar');
  const st = await closeCase(x.caseId); assert(st === 'completed', `el workflow 03 cierra el caso (${st})`);
}
// create_obligation_occurrence: factura de un período que aún no existe para una obligación existente (Vanti, diciembre)
x = await textThroughN8n(t, 'Me llegó la factura de Vanti por 47.000 pesos, vence el 12 de diciembre de 2026');
assert(x.proposal.proposed_data.action === 'create_obligation_occurrence', `obligación existente sin ese período → create_obligation_occurrence (${x.proposal.proposed_data.action ?? x.proposal.proposed_data.resultado})`);
if (x.proposal.proposed_data.action) {
  await decide(t, x.hitl.id); const r2 = await apply(t, x.caseId, x.proposal.id); assert([200, 201].includes(r2.status), `aplicación explícita (${r2.status})`);
  assert(Number((await sql("select count(*)::int n from obligation_occurrences where obligation_id=$1 and due_date='2026-12-12'", [vo.id]))[0].n) === 1, 'período de diciembre creado');
  const r3 = await apply(t, x.caseId, x.proposal.id); assert(r3.status === 200 && r3.body.alreadyApplied === true, 'reaplicar es idempotente');
  assert((await closeCase(x.caseId)) === 'completed', 'el workflow 03 cierra el caso');
}
// needs_completion: falta el proveedor
x = await textThroughN8n(t, 'Quiero registrar un pago que se repite cada mes');
assert(!x.proposal.proposed_data.action, `faltan datos: no hay acción aplicable (${x.proposal.proposed_data.resultado})`);
await decide(t, x.hitl.id, 'rejected'); await closeCase(x.caseId);
await close();
