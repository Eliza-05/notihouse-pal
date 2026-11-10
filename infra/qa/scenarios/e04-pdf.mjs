/** Escenario 4 — Factura PDF ficticia: almacenamiento y descarga reales; texto del PDF extraído por n8n (real); EXTRACCIÓN simulada (mock). */
import { login, http, sql, close, assert, n8nRun, decide, apply, WF02, WF03, ROOT, API } from '../lib.mjs';
import { readFileSync } from 'node:fs';

const t = await login('DANIEL');
const pdf = readFileSync(`${ROOT}/n8n/test-data/factura-ficticia-positiva.pdf`);
const send = () => { const f = new FormData(); f.append('file', new Blob([pdf], { type: 'application/pdf' }), 'factura-ficticia-positiva.pdf'); return http('POST', '/ingestions/documents', { token: t, form: f }); };
const up = await send();
assert(up.status === 201 && up.body.job.type === 'document.process', `subida del PDF (${up.status})`);
const doc = (await sql('select id::text from documents where case_id=$1', [up.body.caseId]))[0];
const url = `${API}/documents/${doc.id}/content`;
const dl = await fetch(url, { headers: { authorization: `Bearer ${t}` } });
const buf = Buffer.from(await dl.arrayBuffer());
assert(dl.status === 200 && buf.equals(pdf), `descarga autenticada devuelve el mismo PDF (${dl.status}, ${buf.length} bytes)`);
assert((await fetch(url)).status === 401, 'descarga sin sesión rechazada (401)');
const dlOther = await fetch(url, { headers: { authorization: `Bearer ${await login('OTHER')}` } });
assert(dlOther.status === 404, `otro usuario no puede descargarlo (${dlOther.status})`);

n8nRun(WF02);
const ps = await sql('select id::text, source, proposed_data from case_proposals where case_id=$1', [up.body.caseId]);
assert(ps.length === 1 && ps[0].proposed_data.action === 'create_obligation_with_occurrence', `propuesta create_obligation_with_occurrence (${ps[0]?.proposed_data?.action})`);
assert(ps[0].proposed_data.data.occurrence.amount === '98500.00' && ps[0].proposed_data.data.occurrence.dueDate === '2026-12-10', 'importe 98500.00 y vencimiento 2026-12-10 de la factura');
const h = (await sql('select id::text, decision_type from hitl_requests where case_id=$1', [up.body.caseId]))[0];
assert(h.decision_type === 'data_confirmation', 'revisión humana pendiente');
await decide(t, h.id);
assert([200, 201].includes((await apply(t, up.body.caseId, ps[0].id)).status), 'aplicación explícita tras aprobar');
const nOb = async () => Number((await sql("select count(*)::int n from obligations where provider_name like 'Servicios Ficticios%'"))[0].n);
assert((await nOb()) === 1, 'obligación y período creados');
n8nRun(WF03);
assert((await sql('select status from cases where id=$1', [up.body.caseId]))[0].status === 'completed', 'workflow 03 cierra el caso');

// Misma factura otra vez (período ya generado). A-5: el workflow 02 usa `resolve`; el backend detecta que el período
// ya tiene esos datos y devuelve «informational» (sin acción aplicable), así que no hay nada que aplicar ni duplicar.
const dup = await send();
console.log(`  [info] mismo PDF otra vez -> HTTP ${dup.status}`);
if (dup.status === 201) {
  n8nRun(WF02);
  const p2 = (await sql('select id::text, proposed_data from case_proposals where case_id=$1', [dup.body.caseId]))[0];
  const h2 = (await sql('select id::text, decision_type from hitl_requests where case_id=$1', [dup.body.caseId]))[0];
  assert(p2 && !p2.proposed_data.action && p2.proposed_data.resultado === 'informational', `la factura repetida no propone ninguna acción (${p2?.proposed_data?.resultado ?? p2?.proposed_data?.action})`);
  assert(h2?.decision_type === 'other', 'revisión informativa (no aplicable)');
  const a2 = await apply(t, dup.body.caseId, p2.id);
  assert([400, 409, 422].includes(a2.status), `aplicar una propuesta no aplicable se rechaza (${a2.status})`);
}
assert((await nOb()) === 1, 'sigue habiendo una sola obligación (sin duplicados)');
await close();
