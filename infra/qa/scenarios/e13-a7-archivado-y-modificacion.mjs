/**
 * Escenario 13 — A-7: desambiguación y continuación (archivar y modificar con IA + HITL), a través de n8n 04 y 03
 * REALES contra el backend y PostgreSQL 18 de QA. Gemini SIMULADO (mock-gemini.mjs): no cuenta como prueba con Gemini real.
 * Usa a Laura (OTHER) para archivar y a Andrés (ANDRES) para modificar: cuentas ficticias de la base QA.
 */
import { login, http, sql, close, assert, textThroughN8n, decide, apply, closeCase, drainQueue } from '../lib.mjs';

const cleanup = async (token, email) => {
  await drainQueue();
  for (const h of await sql("select h.id::text from hitl_requests h join auth_accounts a on a.profile_id=h.owner_id where a.email=$1 and h.status='pending'", [email])) await decide(token, h.id, 'rejected', 'limpieza QA');
};
const obligation = async (t, body) => (await http('POST', '/obligations', { token: t, body: { frequency: 'monthly', dueDay: 15, category: 'internet', ...body } })).body;
const status = async (t, id) => (await http('GET', `/obligations/${id}`, { token: t })).body;
const audits = async (action, id) => Number((await sql("select count(*)::int n from audit_events where action=$1 and metadata->>'resourceId'=$2", [action, id]))[0].n);
const periods = (id) => sql('select id::text, period_start::text, due_date::text, amount, status::text from obligation_occurrences where obligation_id=$1 order by period_start', [id]);
const choose = (t, hitlId, choice) => http('POST', `/hitl-requests/${hitlId}/decision`, { token: t, body: { decision: 'approved', choice } });

// ================= B — ARCHIVADO AMBIGUO: «Quiero eliminar el internet» =================
{
  const t = await login('OTHER');
  await cleanup(t, process.env.QA_USER_EMAIL_OTHER);
  const claro = await obligation(t, { providerName: 'Internet Claro Hogar', concept: 'Internet Claro Hogar', expectedAmount: '89900' });
  const movi = await obligation(t, { providerName: 'Internet Movistar', concept: 'Internet Movistar', expectedAmount: '75000' });
  const pend = (await http('POST', `/obligations/${claro.id}/occurrences`, { token: t, body: { periodStart: '2030-01-01', periodEnd: '2030-01-31', dueDate: '2030-01-15', amount: '89900' } })).body;
  const claroBefore = await periods(claro.id); const moviBefore = await periods(movi.id);

  const x = await textThroughN8n(t, 'Quiero eliminar el internet');
  assert(x.hitl?.decision_type === 'conflict_resolution', `B1 varias coincidencias → conflict_resolution (${x.hitl?.decision_type})`);
  const ch = x.hitl?.options?.choices ?? [];
  assert(ch.length >= 2 && /Claro Hogar.*\$89\.900/.test(JSON.stringify(ch)) && /Movistar.*\$75\.000/.test(JSON.stringify(ch)), `B2 se ofrecen las alternativas (incluye las 2 creadas; el seed aporta otra de internet) con proveedor, concepto e importe (${JSON.stringify(ch.map((c) => c.label))})`);
  assert(x.hitl?.options?.context?.continuation?.intent === 'archive_obligation', `B3 n8n reenvía la continuación del backend (${JSON.stringify(x.hitl?.options?.context?.continuation)})`);
  assert(!x.proposal.proposed_data.action, 'B4 la propuesta inicial NO es aplicable');
  assert((await status(t, claro.id)).status === 'active' && (await status(t, movi.id)).status === 'active', 'B5 nada archivado mientras se espera la selección');

  const r = await choose(t, x.hitl.id, claro.id);
  const fid = r.body?.decision?.followUpRequestId;
  assert(r.status === 200 && fid, `B6 elegir crea la revisión de aprobación (${r.status} follow=${fid})`);
  assert((await status(t, claro.id)).status === 'active', 'B7 elegir NO archiva todavía');
  const f = (await http('GET', `/hitl-requests/${fid}`, { token: t })).body;
  assert(f.proposal?.proposedData?.action === 'archive_obligation' && f.proposal.proposedData.data.obligationId === claro.id, 'B8 propuesta específica de archivado para la elegida');
  assert((f.options?.context?.advertencias ?? []).join(' ').match(/1 período pendiente/), 'B9 advierte del período pendiente');

  await decide(t, fid, 'approved');
  assert((await status(t, claro.id)).status === 'active', 'B10 aprobar ≠ aplicar: sigue activa');
  const a = await apply(t, x.caseId, f.proposal.id);
  assert([200, 201].includes(a.status), `B11 aplicar (${a.status})`);
  assert((await status(t, claro.id)).status === 'archived' && (await status(t, movi.id)).status === 'active', 'B12 solo la elegida queda archivada; la otra sigue activa');
  assert(JSON.stringify(await periods(claro.id)) === JSON.stringify(claroBefore) && JSON.stringify(await periods(movi.id)) === JSON.stringify(moviBefore), 'B13 períodos conservados (incluido el pendiente) y sin cambios');
  assert((await periods(claro.id)).find((p) => p.id === pend.id)?.status === 'pending', 'B14 el período pendiente sigue pendiente');
  assert((await audits('obligation.archive', claro.id)) === 1 && (await audits('obligation.archive', movi.id)) === 0, 'B15 auditoría: un solo archivado, de la elegida');
  const a2 = await apply(t, x.caseId, f.proposal.id);
  assert(a2.status === 200 && (await audits('obligation.archive', claro.id)) === 1, `B16 aplicar de nuevo no duplica (${a2.status})`);
  const st = await closeCase(x.caseId);
  assert(st === 'completed', `B17 el workflow 03 cierra el caso tras la 2.ª aprobación (${st})`);
  const n = Number((await sql("select count(*)::int n from hitl_requests where case_id=$1 and decision_type='data_confirmation'", [x.caseId]))[0].n);
  assert(n === 1, `B18 una sola revisión de aprobación (sin duplicados) (${n})`);
}

// ================= A — MODIFICACIÓN AMBIGUA: «Cambia el vencimiento del internet al día 20» =================
{
  const t = await login('ANDRES');
  await cleanup(t, process.env.QA_USER_EMAIL_ANDRES);
  const tigo = await obligation(t, { providerName: 'Internet Hogar Uno', concept: 'Internet Hogar Uno', expectedAmount: '60000' });
  const etb = await obligation(t, { providerName: 'Internet Hogar Dos', concept: 'Internet Hogar Dos', expectedAmount: '80000' });
  const x = await textThroughN8n(t, 'Cambia el vencimiento del internet al día 20');
  assert(x.hitl?.decision_type === 'conflict_resolution' && (x.hitl.options.choices ?? []).length === 2, `A1 modificación ambigua → 2 alternativas (${x.hitl?.decision_type})`);
  assert(x.hitl?.options?.context?.continuation?.intent === 'update_obligation_schedule' && x.hitl.options.context.continuation.params?.dueDay === 20, `A2 continuación con parámetros (${JSON.stringify(x.hitl?.options?.context?.continuation)})`);
  const r = await choose(t, x.hitl.id, etb.id);
  const fid = r.body?.decision?.followUpRequestId;
  assert(r.status === 200 && fid, `A3 selección → propuesta concreta (${r.status})`);
  const f = (await http('GET', `/hitl-requests/${fid}`, { token: t })).body;
  assert(f.proposal?.proposedData?.action === 'update_obligation_schedule' && f.proposal.proposedData.data.obligationId === etb.id && f.proposal.proposedData.data.changes.dueDay === 20 && f.proposal.proposedData.data.expected.dueDay === 15, `A4 propuesta: día 15 → 20 solo para la elegida (${JSON.stringify(f.proposal?.proposedData?.data)})`);
  assert((await status(t, etb.id)).dueDay === 15, 'A5 antes de aprobar y aplicar nada cambió');
  await decide(t, fid, 'approved');
  assert((await status(t, etb.id)).dueDay === 15, 'A6 aprobar ≠ aplicar');
  const a = await apply(t, x.caseId, f.proposal.id);
  assert([200, 201].includes(a.status), `A7 aplicar (${a.status})`);
  assert((await status(t, etb.id)).dueDay === 20 && (await status(t, tigo.id)).dueDay === 15, 'A8 solo la elegida cambió al día 20; la otra conserva el 15');
  assert((await audits('obligation.update', etb.id)) === 1 && (await audits('obligation.update', tigo.id)) === 0, 'A9 auditoría solo de la elegida');
  assert((await closeCase(x.caseId)) === 'completed', 'A10 caso cerrado por el workflow 03');
}

// ================= C — SIN AMBIGÜEDAD: no hay pasos extra =================
{
  const t = await login('OTHER');
  await cleanup(t, process.env.QA_USER_EMAIL_OTHER);
  const v = await obligation(t, { providerName: 'Enel', concept: 'Energía eléctrica', category: 'electricity' });
  const x = await textThroughN8n(t, 'Ya no pago la energía de Enel, elimina esa obligación');
  assert(x.hitl?.decision_type === 'data_confirmation' && x.proposal.proposed_data.action === 'archive_obligation' && x.proposal.proposed_data.data.obligationId === v.id, `C1 una sola coincidencia → propuesta de archivado directa (${x.proposal.proposed_data.action ?? x.proposal.proposed_data.resultado})`);
  assert((await status(t, v.id)).status === 'active', 'C2 sigue activa hasta aplicar');
  await decide(t, x.hitl.id); const a = await apply(t, x.caseId, x.proposal.id);
  assert([200, 201].includes(a.status) && (await status(t, v.id)).status === 'archived', `C3 aprobar + aplicar archiva (${a.status})`);
  await closeCase(x.caseId);
  // Ya archivada → informativo, sin propuesta aplicable
  const y = await textThroughN8n(t, 'Ya no pago la energía de Enel, elimina esa obligación');
  assert(!y.proposal.proposed_data.action && /archivada/.test(JSON.stringify(y.hitl?.options?.summary ?? '')), `C4 ya archivada → informativo (${y.proposal.proposed_data.resultado})`);
  await decide(t, y.hitl.id, 'rejected'); await closeCase(y.caseId);
  // Obligación inexistente
  let missing = null;
  for (const name of ['Tigo', 'ETB', 'EPM', 'Acueducto', 'Vanti']) {
    const n = Number((await sql("select count(*)::int n from obligations o join auth_accounts a on a.profile_id=o.owner_id where a.email=$1 and o.provider_name ilike $2", [process.env.QA_USER_EMAIL_OTHER, `%${name}%`]))[0].n);
    if (n === 0) { missing = name; break; }
  }
  const z = await textThroughN8n(t, `Ya no pago el servicio de ${missing}, elimina esa obligación`);
  assert(!z.proposal.proposed_data.action, `C5 inexistente → sin propuesta aplicable (${z.proposal.proposed_data.resultado})`);
  await decide(t, z.hitl.id, 'rejected'); await closeCase(z.caseId);
}

// ================= D — SEGURIDAD =================
{
  const t = await login('OTHER'); const ta = await login('ANDRES');
  await cleanup(t, process.env.QA_USER_EMAIL_OTHER);
  const claro2 = await obligation(t, { providerName: 'Internet Uno Q', concept: 'Internet Uno Q' });
  const ajena = await obligation(ta, { providerName: 'Internet Ajena Q', concept: 'Internet Ajena Q' });
  await obligation(t, { providerName: 'Internet Dos Q', concept: 'Internet Dos Q' });
  const x = await textThroughN8n(t, 'Quiero eliminar el internet');
  assert(!(x.hitl?.options?.choices ?? []).some((c) => c.key === ajena.id), 'D1 las alternativas nunca incluyen obligaciones de otro usuario');
  const bad = await choose(t, x.hitl.id, ajena.id);
  assert(bad.status === 400, `D2 elegir una clave no ofrecida (de otro usuario) → 400 (${bad.status})`);
  const other = await choose(ta, x.hitl.id, claro2.id);
  assert(other.status === 404, `D3 otro usuario no puede decidir mi revisión (${other.status})`);
  assert((await status(ta, ajena.id)).status === 'active' && (await status(t, claro2.id)).status === 'active', 'D4 nada fue modificado');
  await decide(t, x.hitl.id, 'rejected'); await closeCase(x.caseId);
}
await close();
