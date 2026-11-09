/** Escenario 8 — Gmail NIVEL 1 (simulado): se invoca el endpoint interno que usa el workflow 05 con mensajes y PDF ficticios.
 *  No hay cuenta Gmail real ni OAuth. La lógica propia del workflow 05 (decodificación, deduplicación, errores) la cubre gmail-stack.test.mjs. */
import { login, http, sql, close, assert, n8nRun, WF02, ROOT } from '../lib.mjs';
import { readFileSync } from 'node:fs';

const pdf = readFileSync(`${ROOT}/n8n/test-data/factura-ficticia-positiva.pdf`);
const MB = 'qa-buzon@example.test';
const send = (fields, { service = true, blob = pdf } = {}) => {
  const f = new FormData(); f.append('file', new Blob([blob], { type: 'application/pdf' }), 'adj.pdf');
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return http('POST', '/internal/gmail/attachments', { service, form: f });
};
const base = { mailbox: MB, messageId: 'msg-qa-0001', partId: '1', receivedAt: '2026-11-09T10:00:00Z' };
const nOb = async () => Number((await sql("select count(*)::int n from obligations where provider_name like 'Servicios Ficticios%'"))[0].n);
const obBefore = await nOb();
let r = await send(base); assert(r.status === 201, `adjunto ficticio registrado (${r.status})`);
const caseId = r.body.caseId;
const owner = (await sql('select a.email from cases c join auth_accounts a on a.profile_id=c.owner_id where c.id=$1', [caseId]))[0].email;
assert(owner === process.env.QA_USER_EMAIL_DANIEL, 'el caso queda asociado al usuario vinculado al buzón (Daniel)');
assert((await sql('select source::text s from cases where id=$1', [caseId]))[0].s === 'gmail', 'origen del caso = gmail');
r = await send(base); assert(r.status === 200 && r.body.caseId === caseId, `repetición del mismo mensaje/parte: deduplicada (${r.status})`);
r = await send(base, { blob: Buffer.concat([pdf, Buffer.from('\n% distinto')]) }); assert(r.status === 409, `mismo mensaje/parte con otro contenido (${r.status})`);
r = await send({ ...base, mailbox: 'otro@example.test', messageId: 'msg-2' }); assert(r.status === 403, `buzón sin vínculo (${r.status})`);
r = await send({ ...base, messageId: 'msg-3', ownerId: '00000000-0000-4000-8000-000000000000' }); assert(r.status === 400, `campo ownerId rechazado (${r.status})`);
r = await send({ ...base, messageId: 'msg-4' }, { service: false }); assert(r.status === 401, `sin token de servicio (${r.status})`);
const tD = await login('DANIEL');
const f = new FormData(); f.append('file', new Blob([pdf], { type: 'application/pdf' }), 'a.pdf');
for (const [k, v] of Object.entries({ ...base, messageId: 'msg-5' })) f.append(k, v);
r = await http('POST', '/internal/gmail/attachments', { token: tD, form: f }); assert(r.status === 401, `JWT de usuario rechazado (${r.status})`);
// El workflow 02 procesa el adjunto (el resto del flujo es idéntico al del PDF manual).
n8nRun(WF02);
const ps = await sql('select proposed_data from case_proposals where case_id=$1', [caseId]);
assert(ps.length === 1 && ps[0].proposed_data.action === 'create_obligation_with_occurrence', `el workflow 02 procesa el adjunto: propuesta (${ps[0]?.proposed_data?.action}); extracción simulada`);
assert((await nOb()) === obBefore, 'sin aprobación humana no se escribió ninguna obligación');
const tL = await login('OTHER');
assert(((await http('GET', '/cases', { token: tL })).body.items ?? []).every((c) => c.id !== caseId), 'otro usuario no ve el caso de Gmail');
await close();
