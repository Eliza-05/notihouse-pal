/** Escenario 7 — HITL: aplicar sin aprobar, rechazar, expirar (workflow 06), cierre (workflow 03). Gemini SIMULADO. */
import { login, http, sql, close, n8nRun, assert, textThroughN8n, decide, apply, WF03 } from '../lib.mjs';
const t = await login('DANIEL'); const t2 = await login('OTHER');
const nObl = async () => Number((await sql('select count(*)::int n from obligations'))[0].n);
const base = await nObl();

// (a) aplicar SIN aprobar
const a = await textThroughN8n(t, 'Registra Movistar, vence el día 12 de cada mes, avísame 3 días antes');
let r = await apply(t, a.caseId, a.proposal.id);
assert([400, 403, 409].includes(r.status), `aplicar sin aprobar es rechazado (${r.status})`);
assert((await nObl()) === base, 'sin aprobación no se creó ninguna obligación');
// (b) otro usuario no puede decidir ni aplicar
r = await decide(t2, a.hitl.id); assert([403, 404].includes(r.status), `otro usuario no puede aprobar (${r.status})`);
r = await apply(t2, a.caseId, a.proposal.id); assert([403, 404].includes(r.status), `otro usuario no puede aplicar (${r.status})`);
// (c) rechazo humano
r = await decide(t, a.hitl.id, 'rejected', 'No es correcto'); assert(r.status === 200 || r.status === 201, `rechazo humano (${r.status})`);
r = await apply(t, a.caseId, a.proposal.id); assert([400, 409].includes(r.status), `aplicar una propuesta rechazada es rechazado (${r.status})`);
assert((await nObl()) === base, 'tras el rechazo no hay cambios en obligaciones');
r = await decide(t, a.hitl.id, 'approved'); assert([400, 409].includes(r.status), `no se puede cambiar una decisión ya tomada (${r.status})`);
n8nRun(WF03);
const st = (await sql('select status from cases where id=$1', [a.caseId]))[0].status;
assert(['completed', 'cancelled'].includes(st), `el workflow 03 cierra el caso rechazado (${st})`);

// (d) expiración: se vence el plazo (dato desechable) y el workflow 06 materializa el vencimiento
const b = await textThroughN8n(t, 'Registra ETB, vence el día 8 de cada mes, avísame 1 días antes');
await sql("update hitl_requests set created_at = now() - interval '2 days', due_at = now() - interval '1 minute' where id=$1", [b.hitl.id]);
const m = n8nRun('nhpMaintSched001'); 
const hs = (await sql('select status from hitl_requests where id=$1', [b.hitl.id]))[0].status;
assert(hs === 'expired', `el workflow 06 materializó el vencimiento (${hs})`);
r = await decide(t, b.hitl.id, 'approved'); assert([400, 409, 410].includes(r.status), `no se puede aprobar tras vencer (${r.status})`);
r = await apply(t, b.caseId, b.proposal.id); assert([400, 409].includes(r.status), `no se puede aplicar tras vencer (${r.status})`);
assert((await nObl()) === base, 'tras la expiración (sin decisión) no se aplicó nada: silencio ≠ aprobación');
await close();
