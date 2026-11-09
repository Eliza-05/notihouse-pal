/** Escenario 6 — Arriendos: alta, cobros automáticos (workflow 06), importes/fechas, confirmación declarativa, aislamiento. */
import { login, http, sql, close, assert, n8nRun, WF06 } from '../lib.mjs';

const t = await login('DANIEL'); const tL = await login('OTHER');
const props = (await http('GET', '/properties', { token: t })).body.items;
const prop = props.find((p) => p.status === 'active') ?? (await http('POST', '/properties', { token: t, body: { name: 'QA Arriendos' } })).body;
const r = await http('POST', '/rentals', { token: t, body: { propertyId: prop.id, tenantAlias: 'Inquilino QA', expectedAmount: '900000', dueDay: 5, startsOn: '2026-11-01', autoGenerate: true } });
assert(r.status === 201, `alta de arriendo (${r.status})`);
const count = async () => Number((await sql('select count(*)::int n from rent_charges where rental_id=$1', [r.body.id]))[0].n);
assert((await count()) === 0, 'antes del barrido no hay cobros (la creación no genera)');
n8nRun(WF06);
const ch = await sql('select period_start::text ps, due_date::text d, expected_amount::text a, status::text s from rent_charges where rental_id=$1 order by 1', [r.body.id]);
assert(ch.length === 2 && ch[0].d === '2026-11-05' && ch[1].d === '2026-12-05' && ch.every((c) => c.a === '900000.00' && c.s === 'expected'), `cobros nov/dic con importe y fecha correctos (${ch.map((c) => c.d)})`);
n8nRun(WF06);
assert((await count()) === 2, 'segundo barrido: sin duplicados');
const list = (await http('GET', `/rentals/${r.body.id}/charges`, { token: t })).body.items;
const conf = await http('POST', `/rentals/${r.body.id}/charges/${list[0].id}/confirm`, { token: t, body: {} });
assert(conf.status === 400, `confirmar sin evidencia es rechazado (${conf.status})`);
const ok = await http('POST', `/rentals/${r.body.id}/charges/${list[0].id}/confirm`, { token: t, body: { evidence: 'Consignación ficticia QA' } });
assert(ok.status === 200, `confirmación declarativa con evidencia (${ok.status})`);
assert((await http('GET', `/rentals/${r.body.id}`, { token: tL })).status === 404, 'otro usuario: 404 al arriendo');
assert((await http('GET', `/rentals/${r.body.id}/charges`, { token: tL })).status === 404, 'otro usuario: 404 a los cobros');
await close();
