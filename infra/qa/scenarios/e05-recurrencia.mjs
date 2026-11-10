/** Escenario 5 — Recurrencia automática (workflow 06, A-4). Integración local: PG18 real + n8n real; sin Gemini. */
import { login, http, sql, close, n8nRun, killSwitch, assert, lastExecution, sleep } from '../lib.mjs';
const WF = 'nhpMaintSched001';
const count = async () => Number((await sql("select count(*)::int n from obligation_occurrences oc join obligations o on o.id=oc.obligation_id where o.provider_name='Tigo'"))[0].n);
const alerts = async () => Number((await sql("select count(*)::int n from alerts"))[0].n);

assert((await count()) >= 1, `precondición: Tigo (autoGenerate) tiene períodos (${await count()})`);
// Preparación (datos desechables): el período siguiente aún no existe.
await sql("delete from obligation_occurrences oc using obligations o where oc.obligation_id=o.id and o.provider_name='Tigo' and oc.period_start >= date_trunc('month', now() + interval '1 month')");
const before = await count();
let r = lastExecution(n8nRun(WF).out);
assert(r.status === 'success', `ejecución 1 del workflow 06 exitosa (${r.status})`);
const after1 = await count();
assert(after1 === before + 1, `ejecución 1 generó el período faltante (${before} -> ${after1})`);
r = lastExecution(n8nRun(WF).out);
const after2 = await count();
assert(after2 === after1, `ejecución 2 idempotente, sin duplicados (${after1} -> ${after2})`);
const dup = await sql("select obligation_id, period_start, count(*) from obligation_occurrences group by 1,2 having count(*)>1");
assert(dup.length === 0, 'sin períodos duplicados en toda la base');
assert((await alerts()) >= 0, `alertas evaluadas tras la generación (alertas: ${await alerts()})`);

// Kill switch de recurrencia: el workflow debe terminar en error PERO las alertas se evalúan.
await sql("delete from obligation_occurrences oc using obligations o where oc.obligation_id=o.id and o.provider_name='Tigo' and oc.period_start >= date_trunc('month', now() + interval '1 month')");
const b3 = await count();
const act = killSwitch('activate', '--scope', 'recurrence_generation', '--operator', 'qa-e05', '--reason', 'QA e05');
assert(act.status === 0, 'kill switch recurrence_generation activado (script oficial)');
await sleep(1500);
const run3 = n8nRun(WF); r = lastExecution(run3.out);
assert(/suspendida/.test(r.err ?? ''), `con kill switch el workflow termina en error visible: ${r.err ?? 'sin mensaje'}`);
assert(run3.out.includes('"Evaluar alertas"') && run3.out.includes('"Anotar fallo de recurrencia"'), 'con kill switch las alertas SÍ se evaluaron (nodo ejecutado) y el fallo se anotó');
assert((await count()) === b3, 'con kill switch NO se generó ningún período');
const res = killSwitch('resume', '--scope', 'recurrence_generation', '--operator', 'qa-e05', '--reason', 'QA e05 terminado', '--test-evidence', 'e05 verificó la suspensión');
assert(res.status === 0, 'kill switch reanudado (script oficial)');
await sleep(1500);
r = lastExecution(n8nRun(WF).out);
assert(r.status === 'success' && (await count()) === b3 + 1, `tras reanudar, se genera de nuevo (${await count()})`);
await close();
