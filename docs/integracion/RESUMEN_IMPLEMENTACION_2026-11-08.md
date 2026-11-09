# Resumen de implementación — sesión 2026-11-08

Todo lo listado aquí vive únicamente en la rama `develop/diego` (no se pushea ni
se mergea a otra rama sin autorización explícita). Se hizo en dos frentes:
primero se cerraron los pendientes de backend de
[`GUIA_INTEGRACION_FRONTEND_BACKEND_MVP.md`](./GUIA_INTEGRACION_FRONTEND_BACKEND_MVP.md),
luego se construyó el frontend completo que consume esa API.

Commits de esta sesión, en orden:

```
f71f255 feat(backend): búsquedas q/unassigned y recurrencia automática de períodos y cobros
6e74290 feat(backend): nuevas acciones aplicables de propuesta (recurrencia, agenda, arriendo)
e5ce03c feat(backend): CORS con lista explícita de orígenes (D18)
057636b feat(backend): aviso personalizado por obligación en obligation_due_soon (D6)
776e169 feat(backend): entrada de texto del asistente (§19.2, N1)
34deb22 feat(backend): resolución determinística del asistente (§19.2-19.3, I2)
5d9daf1 feat(frontend): infraestructura compartida (tipos de API, formato, navegación, componentes)
d6bb2e4 feat(frontend): inmuebles, obligaciones, arriendos y contratos
dbf4b02 feat(frontend): alertas, documentos, voz y casos/HITL
e276db8 feat(frontend): resumen, bandeja de atención y asistente
```

---

## 1. Backend

### 1.1 Búsquedas y filtros (`q`, `unassigned`)

- `backend/src/common/dto-helpers.ts`: `escapeLikePattern()` para escapar
  `%`, `_` y `\` antes de usarlos en `ILIKE`.
- Inmuebles (`properties`) y obligaciones (`obligations`): nuevo parámetro
  `q` (búsqueda por nombre/proveedor) y, en obligaciones, `unassigned`
  (obligaciones sin inmueble asignado).

### 1.2 Recurrencia automática de períodos y cobros

Módulo nuevo `backend/src/recurrence/`:

- `cycle.ts` — cálculo puro del ciclo (día 29-31 clamp a fin de mes, D1;
  frecuencias mensual/bimestral/trimestral/semestral/anual, D5).
- `recurrence.service.ts` — `generateForObligation` / `generateForRental`
  (reutilizados tanto por el barrido programado como por el flujo de
  aplicar propuesta) y `generate()` con barrido por lotes y cursor,
  serializado con `pg_advisory_xact_lock`.
- `internal-recurrence.controller.ts` — `POST /internal/recurrence/generate`,
  protegido por `@Suspendable('recurrence_generation')` (kill-switch nuevo).
- Columna `autoGenerate` (boolean, default `false`) agregada a
  `obligations` y `rentals` — migración
  `database/migrations/0003_auto_generate_recurrence.sql`.
- `due-dates/calendar.ts` — utilidades puras de año-mes (`YearMonth`,
  `addMonthsToYearMonth`, `clampedDayInMonth`, etc.) que sostienen el
  cálculo de ciclos.
- Reglas clave: horizonte de ciclo actual + siguiente (D4), sin backfill
  tras una interrupción del scheduler (D3).

### 1.3 Nuevas acciones aplicables de propuesta

Antes solo existían 2 acciones aplicables desde HITL. Se agregaron 4:

- `create_recurring_obligation`
- `update_obligation_schedule` (con recálculo de `pending` due date, D12)
- `update_occurrence_details`
- `create_recurring_rental`

Cambios principales:

- `backend/src/cases/proposal-actions.ts` — DTOs y `ACTION_CLASSES` map,
  `parseProposalAction` reescrito para despachar por acción.
- `backend/src/cases/proposal-application.service.ts` — un
  `execute*` por acción nueva; `DOCUMENT_DERIVED_ACTIONS` (D7: estas
  acciones nunca dependen del tipo de caso que las originó).
- `database/migrations/0004_proposal_actions_expansion.sql` — relaja
  `proposal_applications` (obligation_id/occurrence_id ahora nullable,
  nueva columna `rental_id`, `CHECK` de "exactamente un recurso"), amplía
  el enum `proposal_application_action`.
- `rentals/rentals.service.ts` — `insertRental()` extraído para
  reutilizarse desde el flujo normal de creación y desde la aplicación de
  propuestas.

### 1.4 CORS con lista explícita de orígenes (D18)

- `FRONTEND_URL` ahora se parsea como lista separada por comas
  (`FRONTEND_URLS: string[]`, máximo 5 orígenes).
- `app.setup.ts` — `origin` dinámico (callback) en vez de un string fijo.
- Nuevos tests: `cors-multi-origin.e2e-spec.ts`,
  `env.validation.spec.ts`.

### 1.5 Aviso personalizado por obligación (D6)

Antes el aviso de una obligación usaba `max(7, reminderDaysBefore)`,
ignorando el valor configurado por el usuario si era menor a 7 días.

- `due-dates/due-date.rules.ts` — `evaluateOccurrenceAlert()`: usa
  `reminderDaysBefore` directamente.
- `alert-evaluation.service.ts` — usa esta función para
  `obligation_due_soon`.
- Se recalibraron ~13 tests existentes que asumían el comportamiento
  antiguo (fixtures con `reminderDaysBefore` muy bajo) y se agregó un
  describe block nuevo específico para D6 en `alerts.e2e-spec.ts`.

### 1.6 Entrada de texto del asistente (N1, §19.2)

- `ingestion/dto/text-ingestion.dto.ts` — `CreateTextIngestionDto` (texto
  libre ≤1000 caracteres, validado con `IsPlainText` nuevo en
  `common/validators.ts`, que rechaza caracteres de control salvo
  `\n`/`\t`).
- `ingestion.service.ts` — `ingestText()`: idempotente, valida propiedad
  opcional del usuario, limita a 3 casos de texto abiertos por usuario a
  la vez (D15, 429 si se excede).
- `POST /ingestions/text` en `ingestion.controller.ts`.
- Kill-switch nuevo: `'text_processing'`, mapeado al job type
  `'text.interpret'`.
- 15 tests e2e nuevos (`ingestion-text.e2e-spec.ts`).

### 1.7 Resolución determinística del asistente (I2, §19.2-19.3)

Módulo nuevo `backend/src/cases/assistant/`:

- `candidate-matching.ts` — `matchCandidates<T>()`: si hay más de un
  candidato igual de probable, nunca elige por el usuario (D17); deja el
  caso para revisión humana con las opciones.
- `reminder-conversion.ts` — convierte "avísame N días antes de una fecha
  absoluta" al `reminderDaysBefore` relativo que usa el dominio.
- `assistant-resolve.service.ts` — `AssistantResolveService.resolve()`:
  valida el claim contra el job (`verifyActiveClaim`), confirma que el
  job es `text.interpret`, y resuelve 8 intents distintos (crear/editar
  obligación, registrar período, confirmar pago, crear/editar arriendo,
  registrar cobro, confirmar cobro, pregunta sobre contrato) a una
  propuesta concreta o a una lista de candidatos para elegir.
- `POST /internal/cases/:id/assistant/resolve` — ruta interna, solo para
  el workflow de n8n (no la llama el frontend directamente).
- 16 tests e2e nuevos (`assistant-resolve.e2e-spec.ts`).

### 1.8 Cobertura de pruebas

Todo lo anterior quedó con test unitario y/o e2e: 570 tests unitarios +
600 tests e2e, en verde en la última corrida completa.

---

## 2. Frontend

Construido desde cero sobre el scaffold ya existente (Vite + React 19 +
TypeScript + React Router 7 + TanStack Query 5 + React Hook Form + Zod),
reutilizando la Landing page y el flujo de login que ya estaban en la
rama. Verificado con `npx tsc -b` (0 errores) y probado a mano en
navegador contra un backend local con datos sembrados.

### 2.1 Infraestructura compartida

- `lib/api/types.ts` — tipos TypeScript para cada endpoint consumido.
- `lib/api/queryKey.ts` — claves de caché con el `user.id` como prefijo,
  para aislar la caché entre usuarios/sesiones.
- `lib/format/` — `dates.ts`, `money.ts`, `labels.ts` (traducción de
  enums del backend a texto), `validation.ts` (helpers de Zod para
  campos de fecha y dinero, compartidos por todos los formularios).
- `lib/navigation.ts` — `resourcePathToRoute()`: traduce el
  `resource.path` que manda el backend (p. ej.
  `/obligations/:id/occurrences/:id`) a una ruta propia del frontend.
- `lib/useAudioRecorder.ts` — grabación de audio en navegador (MediaRecorder,
  límite ~2 min / ≤13 MiB), compartido entre Nota de voz y Asistente.
- `components/` — `AppShell` (header + nav + logout), `Modal`,
  `Pagination`, `StateBlocks` (loading/empty/error consistentes),
  `StatusBadge`.

### 2.2 Inmuebles, Obligaciones, Arriendos, Contratos

CRUD completo por entidad: listado con búsqueda/filtros y paginación de
servidor, alta/edición en modal con validación Zod, pantalla de detalle.

- **Obligaciones**: detalle con tabla de períodos, confirmación
  declarativa de pago/atención (nunca verifica pagos reales — el texto
  del modal lo deja explícito).
- **Arriendos**: detalle con tabla de cobros, confirmación declarativa de
  recepción (evidencia de texto obligatoria).
- **Contratos**: vigencia, día de preaviso; el texto de la UI aclara que
  NotiHouse-Pal no genera ni firma contratos, solo vigila vencimientos.

### 2.3 Alertas, Documentos, Voz, Casos/HITL

- **Alertas** (`/alertas`): lista filtrable por estado, botón de
  descartar, enlaza al recurso vía `resourcePathToRoute`.
- **Documentos** (`/documentos`): subir factura (encola, no interpreta
  al instante), descarga autenticada vía `fetch` + `Blob` (nunca
  `<a href>` directo, porque hace falta el JWT).
- **Nota de voz** (`/voz`): grabar o subir archivo de audio, envía a
  `POST /ingestions/voice`.
- **Casos/HITL** (`/casos`, `/casos/:id`, `/revisiones/:id`): lista de
  solicitudes propias, detalle de caso con sus propuestas, pantalla de
  revisión humana con diff de cambios propuestos y botón "Aplicar" para
  las 6 acciones aplicables del backend (las 2 originales + las 4
  nuevas: recurrencia, agenda de obligación, detalles de período,
  arriendo recurrente).

### 2.4 Resumen, Bandeja de atención, Asistente

- **Resumen** (`/`): KPIs (vencidas/por vencer, cobros, contratos,
  revisiones, alertas, casos), vista previa de "lo más urgente" tomada
  de la bandeja de atención, y dinero abierto por moneda.
- **Bandeja de atención** (`/atencion`): todo lo pendiente en una sola
  tabla ordenada por urgencia, con el botón de acción sugerida por ítem
  (confirmar pago, confirmar recepción, revisar contrato, decidir
  revisión), navega al recurso y marca la alerta asociada como leída.
- **Asistente** (`/asistente`): campo de texto (≤1000 caracteres, con
  contador) que llama a `POST /ingestions/text`, más grabación de voz
  reutilizando el mismo componente de Nota de voz. No simula un chat ni
  llama directamente a la ruta interna de resolución (esa es solo para
  n8n) — el resultado se sigue por "Mis solicitudes" → caso →
  revisión HITL, igual que documentos y voz.

### 2.5 Bugs encontrados y corregidos durante la verificación en navegador

- **`RootRoute` sin `AppShell`**: la ruta `/` autenticada mostraba el
  Resumen sin header ni menú de navegación — quien iniciaba sesión
  quedaba sin forma de llegar a ninguna otra pantalla. Corregido
  envolviendo el Resumen en `AppShell` cuando hay sesión activa.
- **Invalidación de caché incompleta**: `invalidateObligations()` e
  `invalidateRentals()` no invalidaban las queries de `occurrences` /
  `charges`. Al confirmar un período o un cobro, la fila seguía
  mostrando "Pendiente" en pantalla aunque el backend ya lo había
  marcado — solo se corregía con un refresh manual. Corregido agregando
  esa invalidación.
- 27 errores de TypeScript preexistentes (de este mismo trabajo de
  sesión, nunca llegaron a compilar antes del typecheck): el helper
  `qs()` repetido en cada `api.ts` no aceptaba los tipos de parámetros
  sin índice de firma, y los helpers `calendarDateField()` /
  `moneyField()` de Zod perdían la distinción entre campo obligatorio y
  opcional al inferir el tipo. Corregido con sobrecargas de función
  basadas en `ReturnType` en vez de anotar los genéricos de Zod a mano
  (evita acoplarse a la versión instalada de `zod`).

---

## 3. Qué falta (fuera del alcance de esta sesión)

- Probar en vivo el flujo de voz con micrófono real (el código compila y
  reutiliza el mismo componente que Nota de voz, pero no se ejecutó con
  audio real).
- Probar en vivo el flujo HITL de punta a punta: requiere que una
  propuesta llegue generada por un workflow de n8n corriendo, que no
  está activo en este entorno de desarrollo local.
- Nada de esto se pusheó ni se mergeó: todo queda en `develop/diego`
  hasta que se decida lo contrario.
