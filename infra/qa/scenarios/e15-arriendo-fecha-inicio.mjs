/**
 * Escenario 15 — Fecha de inicio de un arriendo hecho con IA (startDate), a través de n8n 04 y 03 REALES contra el
 * backend y PostgreSQL 18 de QA. Gemini SIMULADO (mock-gemini.mjs): no cuenta como prueba con Gemini real.
 * Caso de regresión (Camila, 11-nov): «…a partir del 1 de diciembre de 2026» debe dar startsOn = 2026-12-01.
 * Usa a Andrés (ANDRES): cuenta ficticia de la base QA.
 */
import { readFileSync } from 'node:fs';
import { login, http, sql, close, assert, mock, textThroughN8n, decide, apply, closeCase, drainQueue, ROOT } from '../lib.mjs';

const t = await login('ANDRES');
const email = process.env.QA_USER_EMAIL_ANDRES;
const clean = async () => {
  await drainQueue();
  for (const h of await sql("select h.id::text from hitl_requests h join auth_accounts a on a.profile_id=h.owner_id where a.email=$1 and h.status='pending'", [email])) await decide(t, h.id, 'rejected', 'limpieza QA');
  for (const c of await sql("select c.id::text id from cases c join auth_accounts a on a.profile_id=c.owner_id where a.email=$1 and c.status in ('processing','awaiting_human','received')", [email])) await closeCase(c.id);
};
const rentalsOf = async (propertyId) => sql('select id::text, starts_on::text, due_day, expected_amount::text, tenant_alias, property_id::text from rentals where property_id=$1', [propertyId]);
const totalRentals = async () => Number((await sql('select count(*)::int n from rentals r join auth_accounts a on a.profile_id=r.owner_id where a.email=$1', [email]))[0].n);
const bogotaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

await clean();
let prop = (await sql('select p.id::text from properties p join auth_accounts a on a.profile_id=p.owner_id where a.email=$1 and p.name=$2', [email, 'Apartamento Ensayo']))[0];
if (!prop) prop = (await http('POST', '/properties', { token: t, body: { name: 'Apartamento Ensayo' } })).body;
const propertyId = prop.id;
const other = (await http('POST', '/properties', { token: t, body: { name: `Casa Otra ${Date.now()}` } })).body; // un segundo inmueble: no debe confundirse
void other;
const before = await totalRentals();

const base = 'Registra un arriendo mensual para el inmueble Apartamento Ensayo, con el inquilino Prueba, por 1.200.000 pesos, con cobro el día 5 de cada mes';

// ================= R1 — CASO DE REGRESIÓN EXACTO =================
{
  const x = await textThroughN8n(t, `${base}, a partir del 1 de diciembre de 2026.`);
  const d = x.proposal?.proposed_data;
  assert(d?.action === 'create_recurring_rental', `R1 intención create_recurring_rental (${d?.action ?? d?.resultado})`);
  const r = d?.data?.rental ?? {};
  assert(r.startsOn === '2026-12-01', `R1 startsOn = 2026-12-01 (${r.startsOn})`);
  assert(r.dueDay === 5 && r.expectedAmount === '1200000.00' && r.tenantAlias === 'Prueba', `R1 día de cobro 5, valor 1200000.00, inquilino Prueba (${JSON.stringify(r)})`);
  assert(r.propertyId === propertyId, 'R1 inmueble correcto (Apartamento Ensayo, no el otro)');
  assert(x.hitl?.decision_type === 'data_confirmation', `R1 revisión de confirmación (${x.hitl?.decision_type})`);
  assert(!(x.hitl.options?.context?.advertencias ?? []).length, 'R1 sin advertencia de fecha por defecto (la dio el usuario)');
  assert(/1 de diciembre de 2026/.test(x.hitl.options?.summary ?? ''), `R1 el resumen muestra la fecha de inicio (${x.hitl.options?.summary})`);
  assert((await totalRentals()) === before && (await rentalsOf(propertyId)).length === 0, 'R1 sin escrituras antes de aprobar y aplicar');
  await decide(t, x.hitl.id);
  assert((await rentalsOf(propertyId)).length === 0, 'R1 aprobar ≠ aplicar: todavía no hay arriendo');
  const a = await apply(t, x.caseId, x.proposal.id);
  assert([200, 201].includes(a.status), `R1 aplicar (${a.status})`);
  const rows = await rentalsOf(propertyId);
  assert(rows.length === 1 && rows[0].starts_on === '2026-12-01' && rows[0].due_day === 5 && rows[0].expected_amount === '1200000.00' && rows[0].tenant_alias === 'Prueba', `R1 persistido: ${JSON.stringify(rows[0])}`);
  const a2 = await apply(t, x.caseId, x.proposal.id);
  assert(a2.status === 200 && (await rentalsOf(propertyId)).length === 1, `R1 aplicar de nuevo no duplica (${a2.status})`);
  assert((await closeCase(x.caseId)) === 'completed', 'R1 el workflow 03 cierra el caso');
}

// ================= R2 — FECHA OMITIDA: «hoy» y se advierte =================
{
  await clean();
  const x = await textThroughN8n(t, `${base}.`);
  const r = x.proposal?.proposed_data?.data?.rental ?? {};
  assert(x.proposal?.proposed_data?.action === 'create_recurring_rental' && r.startsOn === bogotaToday(), `R2 sin fecha → hoy en Bogotá (${r.startsOn} vs ${bogotaToday()})`);
  const adv = (x.hitl?.options?.context?.advertencias ?? []).join(' ');
  assert(/No indicaste desde cuándo rige el arriendo/.test(adv), `R2 la advertencia lo dice claramente (${adv.slice(0, 90)})`);
  await decide(t, x.hitl.id, 'rejected', 'QA'); await closeCase(x.caseId);
}

// ================= R3 — FECHAS RELATIVAS / SIN AÑO / INVÁLIDAS: piden confirmar, sin propuesta aplicable =================
for (const [label, tail] of [['relativa «a partir de mañana»', ', a partir de mañana.'], ['sin año «a partir del 1 de diciembre»', ', a partir del 1 de diciembre.'], ['inválida «30 de febrero de 2026»', ', a partir del 30 de febrero de 2026.']]) {
  await clean();
  const x = await textThroughN8n(t, base + tail);
  const d = x.proposal?.proposed_data;
  assert(!d?.action, `R3 ${label}: no genera propuesta aplicable (${d?.action ?? d?.resultado})`);
  assert(/startDate|fecha de inicio/.test(JSON.stringify(d ?? {}) + JSON.stringify(x.hitl?.options ?? {})), `R3 ${label}: pide confirmar la fecha de inicio`);
  assert((await totalRentals()) === before + 1, `R3 ${label}: nada se escribió`);
  if (x.hitl?.status === 'pending') await decide(t, x.hitl.id, 'rejected', 'QA');
  await closeCase(x.caseId);
}

// ================= R4 — FECHA FUTURA LEJANA y diferencia entre inicio y día de cobro =================
{
  await clean();
  const x = await textThroughN8n(t, 'Registra un arriendo mensual para el inmueble Apartamento Ensayo, con el inquilino Prueba, por 1.200.000 pesos, con cobro el día 20 de cada mes, a partir del 1 de marzo de 2027.');
  const r = x.proposal?.proposed_data?.data?.rental ?? {};
  assert(r.startsOn === '2027-03-01' && r.dueDay === 20, `R4 inicio 2027-03-01 y día de cobro 20 (${r.startsOn}/${r.dueDay})`);
  await decide(t, x.hitl.id, 'rejected', 'QA'); await closeCase(x.caseId);
}

// ================= R5 — INMUEBLE INEXISTENTE aunque haya fecha =================
{
  await clean();
  const x = await textThroughN8n(t, 'Registra un arriendo mensual para el inmueble Apartamento Inexistente, con el inquilino Prueba, por 1.200.000 pesos, con cobro el día 5 de cada mes, a partir del 1 de diciembre de 2026.');
  assert(!x.proposal?.proposed_data?.action, `R5 inmueble inexistente → sin propuesta aplicable (${x.proposal?.proposed_data?.resultado})`);
  if (x.hitl?.status === 'pending') await decide(t, x.hitl.id, 'rejected', 'QA');
  await closeCase(x.caseId);
}

// ================= R6 — VOZ: mismo contrato por la ruta de audio =================
{
  await clean();
  await mock('/__control', { transcript: `${base}, a partir del 1 de diciembre de 2026.` });
  const f = new FormData(); f.append('file', new Blob([readFileSync(`${ROOT}/n8n/test-data/audio/nota-voz-agua.wav`)], { type: 'audio/wav' }), 'nota.wav');
  const up = await http('POST', '/ingestions/voice', { token: t, form: f });
  assert(up.status === 201, `R6 ingesta de voz (${up.status})`);
  await drainQueue();
  const ps = await sql('select id::text, source, proposed_data from case_proposals where case_id=$1 order by version', [up.body.caseId]);
  const v2 = ps[1]?.proposed_data;
  assert(ps[0]?.source === 'stt' && v2?.action === 'create_recurring_rental' && v2.data.rental.startsOn === '2026-12-01', `R6 voz: v1 transcripción y v2 arriendo con inicio 2026-12-01 (${v2?.data?.rental?.startsOn})`);
  assert((await rentalsOf(propertyId)).length === 1, 'R6 voz: sin escrituras antes de aprobar');
  const h = (await sql('select id::text from hitl_requests where case_id=$1', [up.body.caseId]))[0];
  await decide(t, h.id, 'rejected', 'QA'); await closeCase(up.body.caseId);
}

await clean();
await close();
