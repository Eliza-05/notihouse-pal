/**
 * Escenario 11 — A-5: facturas PDF sobre obligaciones/períodos que ya existen (workflow 02 → `resolve`).
 * Caso B: factura de obligación existente → update_occurrence_details (HITL → aplicar → período actualizado, sin duplicar).
 * Caso C: la misma factura otra vez → sin cambio que aplicar. Caso D: período confirmado → nunca se sobrescribe.
 * REAL: backend, PostgreSQL 18, n8n 02/03, extracción de texto del PDF. SIMULADO: la extracción de Gemini (mock).
 */
import { login, http, sql, close, assert, n8nRun, decide, apply, closeCase, WF02 } from '../lib.mjs';

/** PDF mínimo de una página con texto Helvetica (una línea por entrada). */
function pdf(lines) {
  const content = lines.map((l, i) => `BT /F1 12 Tf 60 ${760 - i * 28} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const off = [];
  objs.forEach((o, i) => { off.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const invoice = (provider, amount, due, tag) => pdf([
  'FACTURA DE SERVICIO - DOCUMENTO FICTICIO DE PRUEBA',
  `Emisor: ${provider}`,
  'Concepto: Internet hogar',
  'Periodo facturado: del 2026-11-01 al 2026-11-30',
  `Total a pagar: ${amount} COP`,
  `Fecha limite de pago: ${due}`,
  `Referencia ficticia ${tag}`,
]);

const t = await login('DANIEL');
const provider = `Telecom Ficticia ${Date.now() % 100000} S.A.S.`;
const upload = async (buf) => {
  const f = new FormData();
  f.append('file', new Blob([buf], { type: 'application/pdf' }), 'factura.pdf');
  return http('POST', '/ingestions/documents', { token: t, form: f });
};
const processDoc = async (buf) => {
  const up = await upload(buf);
  assert(up.status === 201, `subida del PDF (${up.status})`);
  n8nRun(WF02);
  const prop = (await sql('select id::text, proposed_data, evidence from case_proposals where case_id=$1 order by version desc limit 1', [up.body.caseId]))[0];
  const hitl = (await sql('select id::text, decision_type, options from hitl_requests where case_id=$1', [up.body.caseId]))[0];
  return { caseId: up.body.caseId, prop, hitl };
};

// Preparación: obligación con su período de noviembre ya generado (como haría la recurrencia).
const ob = (await http('POST', '/obligations', { token: t, body: { providerName: provider, concept: 'Internet hogar', category: 'internet', frequency: 'monthly', dueDay: 15 } })).body;
const occ = (await http('POST', `/obligations/${ob.id}/occurrences`, { token: t, body: { periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-11-15' } })).body;
const nOcc = async () => Number((await sql('select count(*)::int n from obligation_occurrences where obligation_id=$1', [ob.id]))[0].n);
const row = async () => (await sql('select amount::text, due_date::text, status::text from obligation_occurrences where id=$1', [occ.id]))[0];
assert(await nOcc() === 1, 'preparación: obligación con 1 período (2026-11)');

// ---- Caso B: factura de una obligación existente.
const b = await processDoc(invoice(provider, '120.000,00', '2026-11-18', 'B'));
assert(b.prop?.proposed_data?.action === 'update_occurrence_details', `B: propuesta update_occurrence_details (${b.prop?.proposed_data?.action ?? b.prop?.proposed_data?.resultado})`);
assert(b.prop.proposed_data.data.occurrenceId === occ.id && b.prop.proposed_data.data.amount === '120000.00', 'B: apunta al período existente con 120000.00');
assert(b.hitl?.decision_type === 'data_confirmation', 'B: revisión humana pendiente (data_confirmation)');
assert((await row()).amount === null, 'B: nada cambió antes de aprobar');
await decide(t, b.hitl.id);
assert((await row()).amount === null, 'B: aprobar NO aplica');
const ab = await apply(t, b.caseId, b.prop.id);
assert([200, 201].includes(ab.status), `B: aplicación explícita (${ab.status})`);
let r = await row();
assert(r.amount === '120000.00' && r.due_date === '2026-11-18', `B: período actualizado (${r.amount}, ${r.due_date})`);
assert(await nOcc() === 1, 'B: sigue habiendo un solo período (sin duplicar)');
assert((await closeCase(b.caseId)) === 'completed', 'B: workflow 03 cierra el caso');
const again = await apply(t, b.caseId, b.prop.id);
assert([200, 409].includes(again.status) && (await row()).amount === '120000.00' && (await nOcc()) === 1, `B: repetir la aplicación no cambia nada (${again.status})`);

// ---- Caso C: la misma factura otra vez.
const c = await processDoc(invoice(provider, '120.000,00', '2026-11-18', 'C'));
assert(!c.prop?.proposed_data?.action && c.prop?.proposed_data?.resultado === 'informational', `C: sin acción aplicable (${c.prop?.proposed_data?.resultado ?? c.prop?.proposed_data?.action})`);
assert(c.hitl?.decision_type === 'other', 'C: revisión informativa, no de aplicación');
await decide(t, c.hitl.id, 'rejected', 'duplicada');
assert(await nOcc() === 1, 'C: no se creó otro período');
await closeCase(c.caseId);

// ---- Caso D: período confirmado.
const conf = await http('POST', `/obligations/${ob.id}/occurrences/${occ.id}/confirm`, { token: t, body: { result: 'paid', reference: 'REF-QA-D' } });
assert([200, 201].includes(conf.status), `D: confirmación declarativa del período (${conf.status})`);
const d = await processDoc(invoice(provider, '150.000,00', '2026-11-25', 'D'));
assert(!d.prop?.proposed_data?.action && d.prop?.proposed_data?.resultado === 'informational', `D: factura sobre período confirmado → sin acción (${d.prop?.proposed_data?.resultado ?? d.prop?.proposed_data?.action})`);
await decide(t, d.hitl.id, 'rejected', 'ya pagado');
r = await row();
assert(r.status === 'paid' && r.amount === '120000.00' && r.due_date === '2026-11-18', `D: el período confirmado no cambió (${r.status}, ${r.amount})`);
assert(await nOcc() === 1, 'D: sin períodos duplicados');
await closeCase(d.caseId);

await close();
