/**
 * Escenario 16 — Voz: «servicio mensual de energía» sin `concept` explícito del modelo (caso real de Camila, 2026-11-12).
 * Audio ficticio real por NestJS + workflow 04 real en n8n QA; transcripción e interpretación SIMULADAS. La interpretación
 * reproduce lo que Gemini devolvió de verdad: category=electricity pero concept=null y sin `missing`.
 * Comprueba que una solicitud completa produce una propuesta APLICABLE, que no se inventa un concepto cuando no hay
 * ninguno en la frase, y que lo que dice el modelo (si trae concepto) no se pisa. Solo en la base QA desechable aprueba y
 * aplica el primer caso para demostrar que la propuesta es aplicable (nunca contra Neon).
 */
import { login, sql, close, assert, mock, drainQueue, http, ROOT, decide, apply, closeCase } from '../lib.mjs';
import { readFileSync } from 'node:fs';

const t = await login('DANIEL');
const base = {
  intent: 'create_recurring_obligation', providerName: 'Ensayo Luz S.A.S.', concept: null, category: 'electricity',
  propertyName: null, tenantAlias: null, amount: '40000.00', currency: 'COP', dueDay: 20, reminderDaysBefore: null,
  reminderDay: null, frequency: 'monthly', month: null, dueDate: null, startDate: null, missing: [], ambiguities: [],
  evidence: [
    { field: 'intent', text: 'Registra el servicio mensual de energía' }, { field: 'category', text: 'energía' },
    { field: 'providerName', text: 'Luz SAS' }, { field: 'amount', text: 'cuarenta mil pesos' },
    { field: 'dueDay', text: 'el día veinte' }, { field: 'frequency', text: 'cada mes' },
  ],
  containsInstructions: false,
};

async function voice(transcript, interpretation) {
  await drainQueue();
  await mock('/__control', { transcript, nextInterpretation: interpretation });
  const f = new FormData();
  f.append('file', new Blob([readFileSync(`${ROOT}/n8n/test-data/audio/nota-voz-agua.wav`)], { type: 'audio/wav' }), 'nota.wav');
  const up = await http('POST', '/ingestions/voice', { token: t, form: f });
  assert(up.status === 201, `ingesta de voz (${up.status})`);
  await drainQueue();
  const caseStatus = (await sql('select status::text s from cases where id=$1', [up.body.caseId]))[0].s;
  const p = (await sql("select proposed_data, evidence from case_proposals where case_id=$1 and source='llm' order by version desc limit 1", [up.body.caseId]))[0];
  return { caseId: up.body.caseId, caseStatus, p };
}

const SPOKEN = 'Registra el servicio mensual de energía de ensayo Luz SAS por cuarenta mil pesos con vencimiento el día veinte de cada mes.';

// 1) Caso real: el modelo no devuelve concept, pero la frase dice «servicio mensual de energía».
const a = await voice(SPOKEN, base);
const ob = a.p?.proposed_data?.data?.obligation;
assert(a.p?.proposed_data?.action === 'create_recurring_obligation', `propuesta aplicable create_recurring_obligation (${a.p?.proposed_data?.action ?? a.p?.proposed_data?.resultado}, faltantes=${JSON.stringify(a.p?.proposed_data?.faltantes)})`);
assert(/energ/i.test(ob?.concept ?? ''), `el concepto sale de lo dicho: «${ob?.concept}»`);
assert(ob?.providerName === 'Ensayo Luz S.A.S.' && ob?.expectedAmount === '40000.00' && ob?.dueDay === 20 && ob?.category === 'electricity' && ob?.frequency === 'monthly', 'proveedor, valor, día, categoría y frecuencia intactos');
assert(a.caseStatus === 'awaiting_human', `caso en revisión humana (${a.caseStatus})`);
const hitl = (await sql("select status::text s from hitl_requests where case_id=$1", [a.caseId]))[0];
assert(hitl?.s === 'pending', 'revisión pendiente: no se aprobó ni se aplicó nada');

// 2) Si el modelo sí trae concepto, se respeta tal cual.
const b = await voice(SPOKEN, { ...base, concept: 'Servicio de energía eléctrica' });
assert(b.p?.proposed_data?.data?.obligation?.concept === 'Servicio de energía eléctrica', `concepto del modelo no se pisa («${b.p?.proposed_data?.data?.obligation?.concept}»)`);

// 3) Nada que derivar: no se inventa concepto y se sigue pidiendo.
const c = await voice(
  'Registra la cuota de Ensayo Club S.A.S. por cuarenta mil pesos con vencimiento el día veinte de cada mes.',
  { ...base, providerName: 'Ensayo Club S.A.S.', category: 'other', evidence: [] },
);
assert(c.p?.proposed_data?.resultado === 'needs_completion' && (c.p?.proposed_data?.faltantes ?? []).includes('concept'), `sin concepto en la frase: se pide completarlo (${JSON.stringify(c.p?.proposed_data?.faltantes)})`);

// 4) Sin aprobación no se creó nada.
assert(Number((await sql("select count(*)::int n from obligations where provider_name like 'Ensayo%'"))[0].n) === 0, 'ninguna obligación creada');
// 5) Solo en la base QA: aprobar → aplicar → workflow 03 demuestra que la propuesta es realmente aplicable.
const hid = (await sql('select id::text from hitl_requests where case_id=$1', [a.caseId]))[0].id;
const pid = (await sql("select id::text from case_proposals where case_id=$1 and source='llm' order by version desc limit 1", [a.caseId]))[0].id;
const d = await decide(t, hid, 'approved');
assert(d.status === 200 || d.status === 201, `aprobación (${d.status})`);
const ap = await apply(t, a.caseId, pid);
assert(ap.status === 200 || ap.status === 201, `aplicación (${ap.status} ${JSON.stringify(ap.body).slice(0, 120)})`);
const end = await closeCase(a.caseId);
assert(end === 'completed', `caso cerrado por el workflow 03 (${end})`);
const ob2 = (await sql("select provider_name, concept, due_day, expected_amount::text amt from obligations where provider_name like 'Ensayo%'"));
assert(ob2.length === 1 && /energ/i.test(ob2[0].concept) && ob2[0].due_day === 20 && ob2[0].amt.startsWith("40000"), `obligación creada con concepto (${JSON.stringify(ob2)})`);
await close();
