/**
 * Ejecuta los escenarios QA reproducibles en orden, sobre una base recién reiniciada.
 * Requisitos: docker compose QA arriba, backend QA (start-backend.mjs), Gemini simulado
 * (mock-gemini.mjs) y los workflows importados (ver docs/qa/INFORME_QA_MVP_2026-11-09.md §Reproducir).
 * Uso: node --env-file=.local/qa/qa.env infra/qa/run-all.mjs
 * NOTA: reiniciar el backend tras el reinicio de la base lo hace el operador (ver informe).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scenarios = ['e01-obligacion-texto.mjs', 'e02-modificacion-d12.mjs', 'e03-voz.mjs', 'e04-pdf.mjs', 'e05-recurrencia.mjs', 'e06-arriendos.mjs', 'e07-hitl.mjs', 'e08-gmail-simulado.mjs', 'e10-resolucion.mjs', 'e11-a5-facturas-existentes.mjs', 'e13-a7-archivado-y-modificacion.mjs', 'e14-errores-ia.mjs', 'e15-arriendo-fecha-inicio.mjs', 'e16-voz-obligacion-concepto.mjs', 'e17-facturas-totales.mjs', 'e12-kill-switches.mjs', 'e09-seguridad-fallos.mjs'];
let failed = 0;
for (const s of scenarios) {
  console.log(`\n=== ${s}`);
  const r = spawnSync(process.execPath, ['--env-file=.local/qa/qa.env', resolve(here, 'scenarios', s)], { cwd: resolve(here, '..', '..'), encoding: 'utf8', timeout: 900000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const lines = out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l));
  console.log(lines.join('\n'));
  const f = lines.filter((l) => l.startsWith('FAIL')).length + (r.status !== 0 && !lines.some((l) => l.startsWith('FAIL')) ? 1 : 0);
  console.log(`--- ${lines.length - lines.filter((l) => l.startsWith('FAIL')).length} PASS, ${f} FAIL${r.status !== 0 ? ` (salida ${r.status})` : ''}`);
  failed += f;
}
process.exitCode = failed ? 1 : 0;
