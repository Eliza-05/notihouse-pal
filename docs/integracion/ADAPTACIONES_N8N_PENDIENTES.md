# Adaptaciones de n8n pendientes (A-1 … A-7)

> **Estado (actualizado el 9-nov-2026, rama `qa/mvp-e2e-n8n`):** A-1, A-2, A-3, A-4 y A-6 están **adaptadas en los JSON versionados y probadas localmente** (PostgreSQL 18, NestJS y n8n en Docker, con **Gemini y Gmail simulados**). **A-5 está parcial** y **A-7 no se implementó**. **Ninguna se probó con Gemini, Gmail, micrófono ni almacenamiento externo reales.** Detalle, evidencia y reproducción: [`docs/qa/INFORME_QA_MVP_2026-11-09.md`](../qa/INFORME_QA_MVP_2026-11-09.md).
>
> Los workflows siguen **inactivos** y con todos los interruptores `AUTORIZAR_*`/`AUTOMATIZACION_*` en `false`: activarlos (y programar su ejecución) sigue siendo decisión de la responsable.

| ID | Estado | Qué se hizo | Prueba (local) | Pendiente real |
|---|---|---|---|---|
| A-1 | **Completa · probada localmente** | 04 reclama `voice.transcribe` + `text.interpret`; el texto omite descarga y transcripción | escenarios 1, 9; `voice-stack` 99/99 | Interpretación real con Gemini |
| A-2 | **Completa · probada con Gemini simulado** | Esquema/prompt con 8 intenciones; anclaje (cifras y palabras), evidencia literal, anti-inyección, nunca confirma pagos | `agent-eval` 43/43; escenario 9 | **Plan de llamadas reales** (≤ 8) con clave de QA |
| A-3 | **Completa · probada localmente** | `Resolver en backend` + `Armar propuesta` (propuesta y HITL por `outcome`); clave `guided` | escenarios 1–3, 10 | Resultado `informational` real |
| A-4 | **Completa · probada localmente** | 06: recurrencia antes de alertas, cursor hasta `complete`, `AUTORIZAR_RECURRENCIA`, kill switch | escenarios 5, 6 | Paginación con > 100 elementos; activar el disparador programado |
| A-5 | **Parcial** | Texto/voz: `update_occurrence_details` y `create_obligation_occurrence` vía `resolve`. **PDF/Gmail no usan `resolve`**: el backend lo rechaza para `document.process` (403, lista cerrada) | escenarios 2, 4, 8, 10 | **Decisión:** permitir `document.process` en `resolve` (backend + prueba) y adaptar 02. Hoy un PDF de un período ya generado propone `create_*` y el backend responde 409 al aplicar |
| A-6 | **Completa · probada localmente** | 03 cierra el caso con las 6 acciones aplicables, rechazo y expiración | escenarios 1, 2, 4, 7, 10 | — |
| A-7 | **No implementada** (opcional) | — | — | Backend, frontend y workflow |

## Convenciones comunes

- Todas las rutas internas usan `Authorization: Bearer <N8N_SERVICE_TOKEN>` y el prefijo `/api/v1`. Un JWT de usuario o la ausencia de token responde **401**.
- Las rutas de un trabajo exigen una **reclamación vigente**: `jobId` + `claimToken` obtenidos de `POST /internal/workflow-jobs/claim`. Token distinto o trabajo no reclamado → **409**; trabajo de otro caso → **404**.
- **Ninguna ruta de esta lista escribe datos de negocio sin aprobación humana.** `resolve` es de solo lectura; la propuesta y la revisión se registran con las rutas internas existentes; el usuario aprueba y aplica desde el navegador (aprobar ≠ aplicar).
- Kill switch: `text_processing` (trabajo `text.interpret`), `voice_processing` (`voice.transcribe`) y `recurrence_generation` (generación). Un alcance suspendido responde como ya documenta `docs/security/gobierno-agente-y-kill-switch.md`.

---

## A-1 · Reclamar `text.interpret` (workflow 04 o factorización a decidir)

| | |
|---|---|
| **Backend existente** | `POST /ingestions/text` (JWT) crea un caso `received` (origen `form`) y un trabajo `text.interpret` en estado `pending`. Alcance de kill switch `text_processing`. |
| **Endpoint de reclamación** | `POST /internal/workflow-jobs/claim` con `{ "workerId": "...", "jobTypes": ["text.interpret"] }` (el filtro `jobTypes` ya existe; para voz sigue siendo `["voice.transcribe"]`). |
| **Payload del trabajo** | `{ "text": "...", "textSha256": "<hex>", "textLength": 62, "hints": { "caseType": "household_obligation", "propertyId"?: "<uuid>", "obligationId"?: "<uuid>", "rentalId"?: "<uuid>", "contractId"?: "<uuid>" } }`. El texto va en `payload.text` (1–1000 caracteres, sin caracteres de control). |
| **Cambio en n8n** | `Reclamar` pide también `text.interpret`; `Preparar trabajo` hoy rechaza cualquier tipo distinto de `voice.transcribe` con «PERMANENTE» y exige `documentType = voice_note`. Para texto se **omiten** `Descargar audio` → `Transcribir` y se entra directamente a la interpretación con `payload.text`. |
| **Qué falta** | Solo la adaptación del workflow. Sin ella el trabajo queda `pending` indefinidamente. |
| **Errores/seguridad** | El texto es contenido no confiable (prompt-injection): se mantiene el código de grounding e inyección ya probado. No se registra el texto en logs. |
| **Probar después** | Enviar un mensaje desde `/asistente`; ver que el caso pasa a `processing` → `awaiting_human`; enviar 4 mensajes seguidos y confirmar el 429 del cuarto; con `text_processing` suspendido, el mensaje se acepta y queda en cola. |

## A-2 · Ampliar la extracción e intenciones (workflows 04 y 02)

| | |
|---|---|
| **Backend existente** | DTO de extracción validado por `resolve` (`ExtractionDto`, `backend/src/cases/assistant/assistant.dto.ts`). |
| **Esquema (n8n → backend)** | `intent` ∈ `create_recurring_obligation`, `register_invoice`, `update_obligation_schedule`, `create_recurring_rental`, `declare_payment`, `declare_rent_received`, `report_rent_unpaid`, `unsupported`. Campos opcionales/`null`: `providerName`, `concept`, `category` (enum de categorías), `propertyName`, `tenantAlias`, `amount` (texto, p. ej. `"85000.00"`), `currency`, `dueDay` (1–31), `reminderDaysBefore` (0–60), `reminderDay` (1–31), `frequency` (`monthly\|bimonthly\|quarterly\|semiannual\|annual`), `month` (`YYYY-MM`), `dueDate` (`YYYY-MM-DD`), `missing[]`, `ambiguities[]`, `evidence`, `containsInstructions`. Campos fuera de la lista → 400. |
| **Qué falta** | Prompt y esquema de Gemini (hoy solo «registrar una obligación»), manteniendo grounding, inyección, fechas relativas y enlaces. El código compartido entre 02 y 04 exige volver a correr `n8n/tests/agent-eval.test.mjs`. **Cuota de Gemini: no gastar llamadas reales hasta tener un plan de pruebas** (1 llamada por texto). |
| **Reglas** | `containsInstructions = true` → `resolve` responde `unsupported`; nunca una propuesta aplicable. |

## A-3 · Conectar la resolución determinística (workflow 04)

| | |
|---|---|
| **Endpoint** | `POST /internal/cases/:caseId/assistant/resolve` |
| **Cuerpo** | `{ "jobId": "<uuid>", "claimToken": "<token>", "extraction": { … } }` |
| **Tipos de trabajo admitidos** | **`text.interpret` y `voice.transcribe`** (lista cerrada). Cualquier otro (`document.process`, etc.) → **403**. *Corregido en esta entrega:* antes solo aceptaba `text.interpret`, por lo que un flujo de voz habría recibido 403. |
| **Respuesta 200** | `{ "outcome": "applicable\|needs_choice\|needs_completion\|guided_manual\|informational\|unsupported", "proposedData": {…}\|null, "choices": [{"key","label"}], "missing": [], "warnings": [], "summary": "...", "consequences": "..." }` |
| **Cómo usarla** | `applicable` → registrar con `POST /internal/cases/:id/proposals` (`source:"llm"`, `proposedData` = el de `resolve`) y `POST /internal/cases/:id/hitl-requests` (`decisionType:"data_confirmation"`). `needs_completion`, `guided_manual`, `informational`, `unsupported` → `proposedData` no es una acción aplicable: registrar propuesta **no aplicable** con `evidence.extraction` y HITL informativo. `needs_choice` → propuesta no aplicable + revisión `conflict_resolution` con `options.context.kind = "target_selection"` (sin botón «Aplicar»). |
| **Intenciones → resultado (verificado en pruebas)** | `create_recurring_obligation` → `applicable` (`create_recurring_obligation`) o `needs_completion`. `register_invoice` → `create_obligation_with_occurrence` si no existe, `create_obligation_occurrence` si existe sin ese período, **`update_occurrence_details`** si el período ya fue generado. `update_obligation_schedule` → `update_obligation_schedule` con `expected`/`changes`, `needs_choice` si hay varias coincidencias, `needs_completion` si falta proveedor o cambio. `create_recurring_rental` → `create_recurring_rental` o `needs_completion`/`needs_choice` por inmueble. `declare_payment`, `declare_rent_received` → `guided_manual` (navega, **nunca** confirma). `report_rent_unpaid` → `informational`. |
| **Garantías** | Solo lectura (probado: no cambia ninguna tabla). Nunca elige entre varias coincidencias (D17). Nunca inventa montos ni fechas. Aísla por dueño: el dueño sale del caso, no de la solicitud. |
| **Errores** | 400 extracción inválida · 401 sin token de servicio · 403 tipo de trabajo no admitido · 404 caso inexistente o trabajo de otro caso · 409 reclamación inválida o vencida. |
| **Voz** | El backend ya acepta el trabajo `voice.transcribe`; **falta** que el workflow 04 llame a `resolve` también en la rama de voz (hoy construye la propuesta en el nodo *Code* `Construir propuesta`). |
| **Probar después** | Texto y voz: «Claro, día 15, avísame 3 días antes» con y sin obligación existente; dos «Claro» (debe pedir elegir); mensaje con instrucciones incrustadas (debe quedar `unsupported`). |

## A-4 · Generar recurrencias antes de evaluar alertas (workflow 06)

| | |
|---|---|
| **Endpoint** | `POST /internal/recurrence/generate` (token de servicio, `@Suspendable('recurrence_generation')`) |
| **Cuerpo** | `{ "workerId": "<1–64 chars>", "batchSize"?: 1–500, "maxBatches"?: 1–100, "cursor"?: "<nextCursor>" }` |
| **Respuesta 200** | `{ evaluationDate, timeZone, correlationId, scanned, obligationPeriodsCreated, rentChargesCreated, unchanged, skipped:{ missingDueDay }, complete, nextCursor }`. Mientras `complete = false`, repetir con `cursor = nextCursor` (solo vale el mismo día; otro día → 400). |
| **Comportamiento** | Solo obligaciones y arriendos `active` con `autoGenerate = true` (por defecto `false`; la migración 0003 no activa nada). Ciclo actual y siguiente (D4); sin relleno histórico tras apagados (D3); `ON CONFLICT DO NOTHING` (idempotente; barridos simultáneos serializados con un bloqueo consultivo). Frecuencias mensual, bimestral, trimestral, semestral, anual; día 29–31 recortado al último día del mes (D1). Obligaciones sin `dueDay` se omiten y se cuentan en `skipped.missingDueDay`. |
| **Orden (D14)** | Llamar **antes** de `Evaluar alertas`, con interruptor y cadencia propios y el mismo patrón de pausa/kill switch. |
| **Qué falta** | Solo el nodo en el workflow 06. |
| **Probar después** | Activar `autoGenerate` en una obligación de prueba; ejecutar el barrido dos veces (la segunda debe crear 0); confirmar que aparece la alerta al evaluar; con el kill switch `recurrence_generation` activo, verificar la suspensión. |

## A-5 · Proponer actualización de detalles de períodos (workflows 02, 04 y 05)

| | |
|---|---|
| **Backend existente** | Acción aplicable `update_occurrence_details` con `data: { obligationId, occurrenceId, amount?, dueDate? }`. Solo períodos `pending` propios; nunca confirmados ni anulados. `resolve` con `register_invoice` la propone cuando ya existe el período generado para ese ciclo. |
| **Qué falta** | Que 02 (PDF), 04 (voz/texto) y 05 (Gmail) usen `resolve` en vez de proponer siempre `create_*` (que hoy responde 409 si el período existe). |
| **Nota de negocio (D12)** | Una `dueDate` fijada así se considera *fecha propia*: un cambio posterior del día habitual (`update_obligation_schedule`) ya no la sobrescribe (ver informe final §«D12»). |
| **Probar después** | Generar el período del mes; enviar una factura con otra fecha; la propuesta debe ser `update_occurrence_details`; aplicarla y verificar que cambiar luego `dueDay` no mueve esa fecha. |

## A-6 · Cierre de casos con las nuevas acciones (workflow 03)

| | |
|---|---|
| **Backend existente** | Las 4 acciones nuevas se aplican por `POST /cases/:caseId/proposals/:proposalId/apply` (JWT). El cierre sigue siendo un trabajo `hitl.decision` que el workflow 03 reclama y completa. |
| **Qué falta** | **Verificar** (no cambiar) que 03 cierra el caso cuando la acción aplicada es una de las nuevas (no depende del tipo de caso, D7). No hay evidencia en el repositorio de que se haya probado 03 con ellas. |
| **Detalle** | La aplicación es idempotente: repetirla devuelve la misma aplicación (`alreadyApplied`). Para `create_recurring_obligation` y `create_recurring_rental` se generan de inmediato el primer período/cobro con el mismo servicio que el barrido. |
| **Probar después** | Aprobar y aplicar cada una de las 4 acciones; confirmar que el caso pasa a `completed`; rechazar una revisión y confirmar el cierre sin cambios. |

## A-7 · Continuaciones (N9) — **OPCIONAL, NO IMPLEMENTADA**

`POST /cases/:caseId/continuations` **no existe** en el backend ni en el frontend. No hay payload `extraction` en `text.interpret`. La experiencia obligatoria para varias coincidencias (D17) es mostrar las alternativas y ofrecer edición manual guiada, sin elegir automáticamente. Implementar N9 requeriría backend, frontend y esta adaptación; **no bloquea la entrega**.

---

## Resumen de preparación

| ID | Backend listo | Falta en n8n | Puedes empezar |
|---|---|---|---|
| A-1 | Sí | Reclamar `text.interpret`, rama sin audio | Sí |
| A-2 | Sí (DTO) | Esquema/prompt de Gemini | Sí (sin gastar cuota) |
| A-3 | Sí, texto **y voz** | Llamar a `resolve` y registrar propuesta/HITL | Sí, tras A-1/A-2 |
| A-4 | Sí | Nodo en workflow 06 | Sí, **después** de migrar Neon (0003) |
| A-5 | Sí | Usar `resolve` en 02/04/05 | Tras A-3 |
| A-6 | Sí | Solo verificar 03 | Tras A-3 |
| A-7 | **No** | Todo | No aplica (opcional) |

> Importante: **A-4 y A-5 no pueden probarse contra Neon hasta que se apliquen las migraciones 0003 y 0004** (ver `INFORME_FINAL_INTEGRACION.md`, §Migraciones).
