# Cierre del MVP — 10 de noviembre de 2026

Rama `qa/mvp-e2e-n8n`. Entorno: PostgreSQL 18 desechable, NestJS local, n8n QA aislado, **Gemini y Gmail simulados**. Este documento complementa [`INFORME_QA_MVP_2026-11-09.md`](INFORME_QA_MVP_2026-11-09.md) (primera pasada).

## 1. Estado final del MVP

| Módulo | Estado | Nota |
|---|---|---|
| Landing, login, sesión, logout, rutas protegidas, 401/429 | Implementado y probado en navegador | Sesión vencida → `/login`; 5 intentos/min → 429 con mensaje claro |
| Dashboard, Bandeja, Alertas | Implementado y probado | Campana y contadores consistentes con la lista |
| Inmuebles, Obligaciones, Arriendos, Contratos | Implementado y probado | Alta, edición, persistencia tras recargar, validaciones |
| Documentos (PDF) | Implementado y probado | Tipo/contenido inválido rechazado (415), descarga autenticada |
| Voz | Subida de archivo probada; **grabación con micrófono NO probada** | Sin hardware |
| Asistente de texto, Casos, HITL | Implementado y probado | Aprobar ≠ aplicar |
| n8n 02–06 | 02 adaptado (A-5); 03, 04, 06 sin cambios de lógica; 05 usa el mismo 02 | Workflows inactivos |
| **A-7 (continuaciones)** | **No implementada, por decisión de alcance** | Ver §9 |

## 2. Cambios realizados (causa raíz → corrección)

| # | Dónde | Causa raíz | Corrección | Verificación |
|---|---|---|---|---|
| 1 | Backend `assistant-resolve.service.ts` | `document.process` no podía usar `resolve` (lista cerrada) → un PDF de un período existente proponía `create_*` y el backend respondía 409 al aplicar | Se admite `document.process`, **solo con la intención `register_invoice`**; cualquier otra intención desde un documento → `unsupported` | e2e 23/23; escenarios e04, e09, e11 |
| 2 | Ídem | Factura sobre período **confirmado** podía acabar en `create_*` (409) | `resolve` devuelve `informational` y no propone acción (caso D) | e2e + e11 |
| 3 | Ídem | La **misma** factura otra vez proponía `update_occurrence_details` idéntico | `informational` si monto y vencimiento coinciden (caso C) | e2e + e04 + e11 |
| 4 | Workflow 02 | Siempre proponía `create_*` | Nodos `Resolver en backend?`, `Resolver en backend`, `Armar propuesta con resolucion`; si el caso ya trae obligación se conserva la ruta anterior | static 83/83, e11 |
| 5 | Backend (test PG) | **Escenario J**: la ventana de alerta es el aviso propio de la obligación (D6, 3 días por defecto); el escenario sembraba vencimientos a 1–5 días y esperaba 30 alertas → 12 activas. Era la **preparación del escenario**, no una regla ni una carrera | La obligación del escenario usa `reminderDaysBefore: 10`. **Las aserciones no se tocaron** | PG18 real **186/186** (antes 185/186) |
| 6 | Backend | Mensaje «El período [object Object]…» (hallado en el navegador) | Se usa `periodStart.slice(0,7)` | test e2e (`not.toContain('[object')`) |
| 7 | Backend | `needs_completion` mostraba `dueDate`, `amount`… | Etiquetas en español | e2e |
| 8 | Frontend | Encabezado desbordaba a 320 px | Sin nombre de usuario y menos relleno ≤ 420 px | 12 rutas × 320 px sin desborde |
| 9 | Frontend | 500 mostraba «Internal Server Error» | Mensaje en español para 5xx genéricos | vitest 14/14 + navegador |
| 10 | Frontend | Elegir una alternativa (`needs_choice`) podía sugerir que ejecuta algo | Leyenda explícita: «queda registrada, pero no ejecuta ningún cambio» | revisión visual |

Tests actualizados por cambio de contrato (no para ocultar errores): `e04` (el duplicado ahora es `informational`), `e08` y `voice-stack` (idem), `e09` (el 403 de `document.process` pasa a 200/`needs_completion` y `unsupported`).

## 3. Resultados de pruebas

| Suite | Resultado |
|---|---|
| Backend unitarias | **582/582** |
| Backend e2e | **613/613** (+4 de A-5) |
| PostgreSQL 18 real (`conc:test`) | **186/186** (J resuelto) y `conc:suite` sin alertas duplicadas |
| Typecheck, build, `drizzle-kit check` | OK. Lint: solo advertencias preexistentes |
| Frontend: tsc, build, vitest | OK, 14/14 |
| n8n `workflows-static` | **83/83** |
| n8n `scheduled-stack` | **OK** (0 fallos) |
| n8n `voice-stack`, `gmail-stack` | Ver §3.1 |
| n8n `agent-eval` | **Fallos preexistentes** de casos de voz (ver §3.1) |
| Escenarios E2E locales (base limpia) | e01 11, e02 14, e03 7, e04 14, e05 12, e06 8, e07 13, e08 12, e10 22, e11 21 (nuevo), e09 42, e12 (nuevo; ver §8) |

### 3.1 Honestidad sobre lo que no pasa limpio

* **`agent-eval`**: 10 casos con nota de voz (N-07, E5, E6, E13-voz, OD-*voz, INV-voz-*) fallan **idénticamente en el commit base `1d5a1fd`** (comprobado ejecutando el árbol base): el evaluador ejecuta los nodos antiguos del workflow 04 y la reescritura A-1…A-3 ya no produce la propuesta en `Construir propuesta`. **No es una regresión de esta rama.** El comportamiento de voz sí está cubierto con ejecución real por `voice-stack`, e03, e09 y e10. El informe del 9-nov indicaba «43/43»: esa cifra no es reproducible hoy. Pendiente: reescribir `runVoice` para la cadena `Construir propuesta → Resolver → Armar propuesta`.
* `voice-stack` y `gmail-stack` se ejecutaron y se ajustaron dos expectativas (ver arriba); su resultado final está en el §12 del informe.

## 4. Pruebas de navegador (Chromium ↔ NestJS ↔ PG18)

| Recorrido | Resultado |
|---|---|
| R1 Gestión manual (inmueble → obligación → editar → recargar) | OK: `POST 201`, `POST 201`, `PATCH 200`, persistido |
| R2 Asistente de texto → n8n → aprobar → aplicar | OK: `POST decision 200`, `POST apply 201`; antes de aprobar **no existe** el botón Aplicar |
| R3 Modificación (`update_obligation_schedule`) | OK; período de noviembre conserva su fecha propia (D12), diciembre pasa al día 25 |
| R4 Voz | **Audio de archivo** subido desde la UI, transcripción visible, resultado `needs_completion`. **Micrófono físico: no probado** |
| R5 PDF nuevo | OK: propuesta `create_obligation_with_occurrence` → aplicada |
| R6 Factura de obligación existente | OK: `update_occurrence_details`, sin duplicar |
| R7 Arriendos | OK: alta, cobro, evidencia obligatoria, «Recibido» persistido |
| R8 Contratos | OK: validación de fechas, alta, corrección de fecha, vigencia y vencimiento |
| R9 HITL | Aprobar, rechazar, aplicar, informativa sin acción. Expiración: cubierta por e07/e09 (API), no por UI |
| R10 Alertas | OK: mantenimiento 06 → alertas visibles; «Ver» marca leída; «Descartar» persiste |
| R11 Errores | OK: validaciones, PDF inválido (415), sesión vencida, 429, 404, 5xx, fallo de red |
| R12 Aislamiento | OK: otra cuenta recibe 404 en rutas, aprobación, PATCH y alta de cobro ajenos; 401 sin token |
| Responsive 320/360/390/768/1280 | Sin desborde horizontal en las 11 rutas principales (tras corrección 8) |

Limitaciones: el navegador de pruebas reserva 15 px para la barra de desplazamiento (ancho útil de 320 = 305 px). No se hizo una auditoría de contraste ni de foco con herramientas; solo nombres accesibles y estructura (primera pasada).

## 5. Integraciones n8n

| Workflow | Estado |
|---|---|
| 02 Documentos | Adaptado (A-5). Casos B, C, D y E probados |
| 03 Cierre HITL | Sin cambios; cierra los 6 tipos de acción |
| 04 Texto y voz | Sin cambios de lógica |
| 05 Gmail | Sin cambios; el adjunto lo procesa el 02 (escenario e08) |
| 06 Mantenimiento | Sin cambios; probado en R10 y e05 |
| Disparadores programados | **Siguen desactivados** (importados con `active=false`) |

A-1…A-4 y A-6: completas (informe 9-nov). **A-5: cerrada.** A-7: no implementada.

## 6. Gemini

**Gemini real: NO ejecutado. 0 llamadas consumidas.** No hay clave de QA autorizada: la única credencial real vive en el volumen n8n de otro entorno, que no debe reutilizarse. Todas las interpretaciones de este documento son del simulado (`modelVersion: "SIMULADO-qa"`). El plan de ≤ 8 llamadas sigue pendiente (informe 9-nov, §9).

## 7. Gmail

**Gmail real: NO ejecutado** (sin OAuth de una cuenta de pruebas). Validado con Gmail simulado (`gmail-stack`, e08). Para la prueba real la responsable debe crear en n8n QA la credencial OAuth2 de Gmail con alcance de solo lectura sobre un buzón de pruebas propio; no se necesitan contraseñas.

## 8. Seguridad

* JWT: 401 sin token, sesión vencida redirige, logout limpia almacenamiento.
* Aislamiento: 404 en lectura y mutación ajenas (R12).
* Límite de login: 429 al 5.º intento fallido.
* **Kill switches** (e05, e09, e12) sobre la base QA con el script oficial: `global`, `alert_evaluation`, `recurrence_generation`, `text_processing`, `proposal_application` → 503, sin cambios de datos, auditoría `kill_switch.activate/resume`, la **reanudación exige evidencia de prueba**, y todo funciona al reanudar.
* `case_processing` solo gobierna trabajos genéricos `case.*` (el MVP no usa ninguno); se verificó que **no** afecta a texto. Los alcances `document_processing`, `voice_processing`, `hitl_closure`, `hitl_expiry` y `gmail_ingestion` no se ejercitaron individualmente en esta pasada.
* Un PDF/Gmail ya no puede pedir `create_recurring_obligation`, arriendos ni declarar pagos (A-5).

## 9. Problemas pendientes

1. **A-7**: requiere endpoint nuevo, un nuevo tipo de trabajo y un workflow nuevo; es un mecanismo mayor, no un ajuste. La UI avisa que elegir una alternativa **no** ejecuta nada.
2. `agent-eval`: casos de voz obsoletos (preexistente, §3.1).
3. Gemini real, Gmail real y micrófono físico sin probar.
4. Expiración de revisión desde la UI no ejercitada.
5. JWT de 30 min sin refresco; login limitado a 5/min (riesgo en la demo).

## 10. Criterios de aceptación (resumen)

| Criterio | Navegador | API/escenario | Real/simulado | Resultado |
|---|---|---|---|---|
| Proceso automatizado (texto→propuesta) | R2, R3 | e01, e02 | n8n real, IA simulada | Aprobado |
| Documentos PDF | R5, R6 | e04, e11 | n8n real, extracción simulada | Aprobado |
| Voz | R4 (archivo) | e03 | STT simulado | Aprobado con límite |
| Supervisión humana (aprobar ≠ aplicar) | R2 | e07 | Real | Aprobado |
| Gestión de excepciones (duplicado, confirmado, 409) | R6 | e11 | Real | Aprobado |
| Alertas | R10 | e05 | Real | Aprobado |
| Recurrencias | — | e05, e06 | Real | Aprobado |
| Kill switches | — | e05, e09, e12 | Real | Aprobado |
| Seguridad / aislamiento | R12 | e09 | Real | Aprobado |
| Gemini / Gmail reales | — | — | **No ejecutado** | Pendiente |

## 11. Preparación de la sustentación

Servicios: Docker (`notihouse-qa-postgres`, `notihouse-qa-n8n`), backend (`infra/qa/start-backend.mjs`), `mock-gemini.mjs`, Vite en 5174. Recorrido sugerido: login → Resumen → asistente («Registra el internet de Claro cada mes, vence el día 12, por 55.000 pesos») → ejecutar workflow 04 → Revisión → Aprobar → Aplicar → subir PDF de factura → workflow 02 → factura repetida (muestra «ya tiene esos datos») → alertas → kill switch. Tras un reinicio de la base, las contraseñas se regeneran (`qa.env`).

## 12. Git

Rama `qa/mvp-e2e-n8n`; commits de esta pasada: ver `git log 1d5a1fd..HEAD`. No se tocaron `develop`, `main`, Render, Vercel ni Neon. No se subió ningún secreto (`.local/` ignorado). No se hizo push (no se pidió explícitamente subir; ver respuesta final).

## 13. Dictamen

**GO condicionado para merge a `develop`**: backend, PG18 y escenarios pasan; el MVP funciona en navegador. Condiciones: aceptar que A-7 y `agent-eval` de voz quedan documentados como pendientes. **NO GO para activar** automatizaciones en producción hasta validar Gemini real, Gmail real y el entorno desplegado.
