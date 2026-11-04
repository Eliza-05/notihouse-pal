# Vencimientos, alertas internas, bandeja de atención y dashboard (Fase 4.2E)

Este documento describe el motor determinístico de vencimientos y las APIs que lo usan: alertas internas, bandeja unificada de atención y resumen del dashboard. La aplicación de propuestas aprobadas está en [proposal-application.md](proposal-application.md).

> **Alcance.** Todo lo descrito aquí ocurre **dentro de la plataforma**. No se envían notificaciones push (FCM), correos, SMS, WhatsApp ni mensajes a arrendatarios, y ningún registro indica que algo fue "entregado".

## 1. Motor de vencimientos

Implementación: `backend/src/due-dates/` (`due-date.rules.ts`, funciones puras, y `DueDateEvaluationService`, que aporta la configuración y el reloj).

### 1.1 Principios

- **Determinístico.** El mismo registro, con el mismo estado y la misma fecha de referencia, produce siempre el mismo resultado.
- **Sin escrituras por el paso del tiempo.** El motor nunca cambia estados: no marca períodos como `overdue`, cobros como `received`, contratos como `expired`/`terminated` ni los renueva. Solo calcula.
- **Reloj inyectable.** La fecha de referencia sale de un proveedor `CLOCK`; las pruebas lo sustituyen por un reloj fijo.
- **Una sola lógica.** Las alertas usan las funciones TypeScript; la bandeja y el dashboard usan expresiones SQL equivalentes (necesarias para ordenar, paginar y agregar en PostgreSQL). Una prueba e2e verifica que ambas clasifican igual.

### 1.2 Fechas y zona horaria

- Zona horaria de referencia: **`America/Bogota`** (configurable con `DUE_DATES_TIME_ZONE`).
- "Hoy" es el día civil del instante actual en esa zona. Ejemplo: `2027-01-01T03:00Z` es todavía `2026-12-31` en Bogotá.
- `due_date`, `ends_on` y similares son **fechas de calendario** (`YYYY-MM-DD`, columnas `date`). La aritmética de días se hace sobre el día civil, sin horas, por lo que no hay errores de un día al pasar por UTC ni dependencia del navegador.
- Las revisiones HITL tienen una fecha límite con hora (`due_at`, `timestamptz`); se comparan contra el instante actual. Para mostrarlas junto a las demás se usa su día civil en Bogotá.

### 1.3 Condiciones

| Condición | Significado |
|---|---|
| `scheduled` | Abierto, pero fuera del umbral de aviso. No requiere atención todavía. |
| `upcoming` | Abierto y vence dentro de 1..N días (N = umbral). |
| `due_today` | Abierto y vence hoy. |
| `overdue` | La fecha pasó y sigue abierto (sin confirmación, recepción o revisión). |
| `resolved` | Sin acción pendiente. |

Para HITL: `pending` (plazo holgado), `due_soon` (quedan ≤ `DUE_DATES_HITL_SOON_HOURS`), `overdue` (plazo cumplido, aún sin materializar como `expired`) y `resolved`.

Cada evaluación devuelve también `daysUntil` (negativo si pasó), `daysOverdue` y el umbral aplicado (`windowDays`).

### 1.4 Reglas por fuente

| Fuente | Estados abiertos | Estados resueltos | Fecha evaluada | Umbral |
|---|---|---|---|---|
| Períodos (`obligation_occurrences`) | `pending`, `overdue` | `paid`, `attended`, `cancelled` | `due_date` | `max(DUE_DATES_OBLIGATION_DAYS, obligations.reminder_days_before)` |
| Cobros (`rent_charges`) | `expected`, `pending`, `overdue` | `received`, `cancelled` | `due_date` | `DUE_DATES_RENT_CHARGE_DAYS` |
| Contratos (`contracts`) | `active` | `expired`, `terminated` | `ends_on` | `max(DUE_DATES_CONTRACT_DAYS, notice_period_days)` |
| Revisiones (`hitl_requests`) | `pending` | `approved`, `rejected`, `expired`, `cancelled` | `due_at` | `DUE_DATES_HITL_SOON_HOURS` |

- Un período `paid`, `attended` o `cancelled` **nunca** genera un recordatorio de pago, aunque su fecha haya pasado.
- Un cobro `received` o `cancelled` **nunca** aparece como ingreso pendiente.
- El valor del cobro no interviene: cambiar el canon del arriendo no altera cobros ya registrados.
- Un contrato `active` cuya fecha final pasó queda `overdue` ("fecha de finalización superada") para que una persona lo revise. **No hay renovaciones automáticas.**
- Se evalúa el estado del período o cobro, no el de la definición: un período pendiente de una obligación pausada sigue pendiente.

### 1.5 Umbrales iniciales (parámetros operativos del MVP)

| Variable | Valor inicial | Rango |
|---|---|---|
| `DUE_DATES_TIME_ZONE` | `America/Bogota` | Zona IANA válida |
| `DUE_DATES_OBLIGATION_DAYS` | 7 | 0–60 |
| `DUE_DATES_RENT_CHARGE_DAYS` | 7 | 0–60 |
| `DUE_DATES_CONTRACT_DAYS` | 30 | 0–365 |
| `DUE_DATES_HITL_SOON_HOURS` | 6 | 1–24 |

No son compromisos contractuales ni requisitos legales. El repositorio no contiene un PDD/SDD con otros valores. El esquema sí define dos parámetros por registro (`reminder_days_before`, por defecto 3, y `notice_period_days`); el motor aplica **el mayor** entre el valor del MVP y el del registro, para no avisar nunca más tarde de lo que pidió el usuario ni de lo que fija el MVP. Esta es una decisión inicial a revisar (ver informe de la fase).

### 1.6 Ejemplos (hoy = 2026-11-18, Bogotá)

| Registro | Resultado |
|---|---|
| Período `pending`, vence 2026-11-26, recordatorio 3 | `scheduled` (8 días > 7) |
| Período `pending`, vence 2026-11-25 | `upcoming`, `daysUntil = 7` |
| Período `pending`, vence 2026-11-18 | `due_today` |
| Período `overdue`, vence 2026-11-08 | `overdue`, `daysOverdue = 10` |
| Período `paid`, vence 2026-11-01 | `resolved` |
| Cobro `expected`, vence 2026-11-22 | `upcoming` |
| Contrato `active`, finaliza 2026-12-15 | `upcoming` (27 días ≤ 30) |
| Contrato `active`, preaviso 90, finaliza 2027-01-30 | `upcoming` (umbral 90) |
| Contrato `terminated`, finalizó 2026-11-01 | `resolved` |
| Revisión `pending`, vence en 4 horas | `due_soon` |

### 1.7 Limitaciones

- Los días hábiles y festivos no se consideran.
- El motor no genera períodos ni cobros a partir de `due_day`/`frequency`: solo evalúa los registros existentes.
- Bogotá no tiene horario de verano; con otra zona configurada, `Intl` y `AT TIME ZONE` de PostgreSQL resuelven los cambios de hora.

## 2. Alertas internas

### 2.1 Persistencia (`alerts`, migración `0002`)

Hace falta una tabla porque el usuario debe poder marcar alertas como leídas, descartarlas y consultar el historial, y porque la evaluación repetida no debe crear duplicados. No se reutilizan `audit_events` (append-only, no operativa) ni `workflow_jobs` (cola de n8n).

| Columna | Uso |
|---|---|
| `id` | UUID |
| `owner_id` | Propietario (FK a `profiles`). Lo determina el recurso en PostgreSQL, nunca el cliente. |
| `type`, `severity` | Tipo de alerta y severidad (`info`, `warning`, `critical`). |
| `occurrence_id` / `rent_charge_id` / `contract_id` / `hitl_request_id` | Recurso relacionado: **exactamente uno** (check `alerts_single_resource`), cada uno con FK. |
| `relevant_date` | Fecha de calendario que originó la alerta. |
| `dedup_key` | `tipo:recurso:fecha`, única por propietario. |
| `state` | `active`, `dismissed` (decisión del usuario) o `resolved` (decisión de la evaluación). |
| `read_at`, `dismissed_at`, `resolved_at`, `resolution_reason` | Ciclo de vida. Checks garantizan su coherencia con `state`. |
| `created_at`, `updated_at` | Marcas de tiempo. |

No se copian montos, nombres ni datos del recurso: se consultan en la entidad original. El historial no se borra.

**Índices:** `alerts_owner_dedup_unique (owner_id, dedup_key)` (deduplicación y búsquedas por propietario), `alerts_owner_created_idx (owner_id, created_at)` (listado ordenado) y cuatro índices únicos parciales `alerts_active_*_unique` sobre cada columna de recurso con `state = 'active'`, que garantizan **como máximo una alerta activa por recurso** (nunca dos avisos contradictorios) y sirven para buscar la alerta activa de un recurso.

### 2.2 Tipos

| Tipo | Origen | Severidad |
|---|---|---|
| `obligation_due_soon` | Período `upcoming` o `due_today` | warning |
| `obligation_overdue` | Período `overdue` | critical |
| `rent_charge_due_soon` | Cobro `upcoming` o `due_today` | warning |
| `rent_charge_overdue` | Cobro `overdue` (no recibido) | critical |
| `contract_ending_soon` | Contrato `upcoming` o `due_today` | warning |
| `contract_end_passed` | Contrato activo con fecha final superada | critical |
| `hitl_pending` | Revisión pendiente con plazo holgado | warning |
| `hitl_due_soon` | Revisión a ≤ 6 h de vencer | critical |
| `hitl_overdue` | Revisión con plazo cumplido sin decisión | critical |

`info` queda reservado; ningún tipo lo usa todavía.

### 2.3 Deduplicación, escalamiento y obsolescencia

- **Clave estable:** `tipo:recurso:fecha` + propietario. Repetir la evaluación el mismo día no crea nada (`unchanged`).
- **Escalamiento:** cuando un período pasa de `upcoming` a `overdue`, cambia la clave: la alerta anterior se marca `resolved` (`superseded`) y se crea la nueva, en la misma transacción.
- **Cambio de fecha:** la nueva fecha produce otra clave; la alerta anterior se resuelve (`superseded`). Si la fecha vuelve a su valor original, la alerta anterior se **reactiva** en lugar de duplicarse.
- **Resolución:** si el usuario confirma el pago o la recepción, anula el registro, termina el contrato o decide la revisión, la evaluación marca la alerta `resolved` (`resource_closed`). Si el registro sigue abierto pero salió del umbral (p. ej. se aplazó la fecha), `no_longer_applicable`.
- **Vigencia inmediata sin escrituras:** las consultas calculan el **estado efectivo**: una alerta `active` cuyo recurso ya se cerró (o cuya fecha cambió) se presenta como `resolved` y `requiresAttention: false` desde el primer GET, aunque la evaluación aún no la haya marcado.
- **Descartes respetados:** si el usuario descartó una alerta, la evaluación no la recrea. Solo una nueva situación (otra clave, p. ej. el paso a `overdue`) genera otra alerta.
- **Concurrencia:** la inserción usa `ON CONFLICT DO NOTHING` sobre las restricciones únicas y las alertas activas del recurso se bloquean (`FOR UPDATE`) antes de resolverlas. Dos evaluaciones simultáneas no duplican alertas.

### 2.4 API de usuario (JWT)

| Método | Ruta | Función |
|---|---|---|
| GET | `/api/v1/alerts` | Listar alertas propias |
| GET | `/api/v1/alerts/:id` | Consultar una alerta |
| POST | `/api/v1/alerts/:id/read` | Marcar como leída (idempotente) |
| POST | `/api/v1/alerts/:id/dismiss` | Descartar (idempotente; 409 si ya está resuelta) |

Filtros de `GET /alerts`: `state` (`active` = vigente, `dismissed`, `resolved` = estado efectivo), `read` (`true`/`false`), `type`, `severity`, `requiresAttention` (`true` = solo vigentes), `order` (`desc` por defecto, por `createdAt`), `page`, `pageSize` (máx. 100). Cualquier otro parámetro (p. ej. `ownerId`) responde 400.

Respuesta (resumen):

```json
{
  "id": "…", "type": "obligation_overdue", "severity": "critical",
  "title": "Obligación vencida sin confirmar",
  "message": "El período venció el 2026-11-16 y no tiene confirmación de pago o atención.",
  "relevantDate": "2026-11-16", "state": "active", "requiresAttention": true,
  "read": false, "readAt": null, "dismissedAt": null, "resolvedAt": null, "resolutionReason": null,
  "resource": { "type": "obligation_occurrence", "id": "…", "path": "/obligations/…/occurrences/…" },
  "createdAt": "…", "updatedAt": "…"
}
```

Reglas:

- El propietario sale del JWT. Una alerta ajena responde **404** en lectura, `read` y `dismiss`, sin revelar si existe.
- Leer o descartar **no** confirma pagos o cobros, no decide revisiones y no modifica contratos.
- `alert.read` y `alert.dismiss` se auditan una vez (las repeticiones no generan eventos).

### 2.5 Evaluación interna (token de servicio)

`POST /api/v1/internal/alerts/evaluate` — exige `Authorization: Bearer <N8N_SERVICE_TOKEN>`; un JWT de usuario responde 401.

```json
{ "workerId": "n8n-scheduler", "batchSize": 100, "maxBatches": 20, "cursor": "…opcional…" }
```

- No acepta fecha, propietario, filtros ni SQL: la fecha de referencia es "hoy" en la zona configurada y el alcance es **todas las cuentas** (proceso de servicio documentado). Campos extra → 400.
- Fases, en orden: períodos, cobros, contratos, revisiones (crear o escalar alertas) y `resolve` (resolver alertas activas que ya no corresponden). Cada fase recorre los registros por `id` (paginación estable por clave) en lotes de `batchSize`; **cada lote es una transacción corta**. La selección SQL ya filtra estados abiertos y la ventana del umbral, para no leer filas irrelevantes.
- Si se alcanzan `maxBatches` lotes, la respuesta trae `complete: false` y `nextCursor`; la siguiente llamada continúa desde allí. El cursor solo vale para la misma fecha de referencia (si cambió el día, 400 y se reinicia).
- Solo escribe en `alerts` y `audit_events`. Nunca modifica períodos, cobros, contratos ni revisiones.
- Cada alerta creada, resuelta o reactivada registra `alert.create`, `alert.resolve` o `alert.reactivate` (actor `workflow`, `n8n:<workerId>`) con el `correlation_id` de la solicitud (cabecera `X-Correlation-Id` o uno nuevo). Una evaluación sin cambios no escribe nada. Si la auditoría falla, el lote se revierte.

Respuesta:

```json
{
  "evaluationDate": "2026-11-18", "timeZone": "America/Bogota", "correlationId": "…",
  "scanned": 16, "created": 8, "reactivated": 0, "resolved": 0, "unchanged": 8,
  "complete": true, "nextCursor": null
}
```

### 2.6 Integración futura con n8n y notificaciones externas

- n8n podrá invocar `POST /internal/alerts/evaluate` con un *Schedule Trigger* (p. ej. cada hora o a las 6:00 de Bogotá), repitiendo con `nextCursor` mientras `complete` sea `false`. Repetir la llamada es seguro.
- Para futuras notificaciones push, el insumo natural son los eventos `alert.create` (o las alertas `active` y no leídas). El envío deberá registrar su propio estado de entrega en una estructura específica y respetar la idempotencia por `alert.id`; **no está implementado** y FCM **no** está conectado.
- Los recordatorios a arrendatarios (terceros) requieren aprobación humana (`hitl_decision_type = reminder_approval`). Una alerta o una evaluación automática **nunca** autoriza enviar mensajes a terceros.

## 3. Bandeja unificada de atención

`GET /api/v1/attention` (JWT) — parámetros: `kind` (opcional: `obligation_occurrence`, `rent_charge`, `contract`, `hitl_request`), `page`, `pageSize` (máx. 100).

### 3.1 Fuentes

- Períodos abiertos con condición `upcoming`, `due_today` u `overdue`.
- Cobros abiertos en las mismas condiciones.
- Contratos `active` dentro del umbral o con fecha final superada.
- Revisiones HITL `pending` asignadas al usuario.
- Alertas vigentes: no se repiten como elementos aparte (se referirían al mismo recurso). Cada elemento indica en `alert` la alerta activa de su recurso y si fue leída.

Cada rama de la consulta filtra por `owner_id` **en PostgreSQL** (nunca se filtra en memoria). No se devuelven documentos, audios, propuestas ni el texto de las revisiones (`options.summary`), solo un título genérico.

### 3.2 Prioridad (determinística, no es una predicción)

| Prioridad | Elementos |
|---|---|
| 1 | Revisiones HITL próximas a vencer (`due_soon`) o vencidas sin decisión |
| 2 | Períodos o cobros vencidos; contratos con fecha final superada |
| 3 | Vencimientos de hoy |
| 4 | Compromisos dentro del umbral y revisiones HITL con plazo holgado |

No hay nivel 5 ("informativo") porque ningún elemento de la bandeja lo usa todavía.

### 3.3 Orden y paginación

Orden total y estable: `priority`, `relevantDate`, `dueAt` (solo HITL; nulos primero), `kind`, `id`. La paginación (`LIMIT/OFFSET`) se aplica **sobre el conjunto unificado** en una sola consulta (`WITH … UNION ALL …`), y `total` se cuenta sobre el mismo conjunto: no se pagina por fuente ni se combinan páginas parciales. No hay consultas N+1 (los títulos salen de JOIN en la misma consulta).

### 3.4 Elemento

| Campo | Descripción |
|---|---|
| `kind`, `id` | Tipo e identificador del recurso |
| `title`, `description` | Texto breve (p. ej. "Energía — Empresa de energía", "Vence en 3 días") |
| `relevantDate`, `dueAt` | Fecha de calendario; hora límite (solo HITL) |
| `status`, `condition`, `priority`, `daysUntil` | Estado almacenado, condición del motor, prioridad y días |
| `amount`, `currency` | Valor esperado del período o cobro (no es un pago realizado) |
| `suggestedAction` | `confirm_payment`, `confirm_receipt`, `review_contract`, `decide_review`, `view_review` |
| `resource` | `{ type, id, path }` para navegar al detalle |
| `alert` | `{ id, read }` o `null` |

La respuesta incluye `referenceDate` (hoy en Bogotá).

## 4. Dashboard

`GET /api/v1/dashboard/summary` (JWT). Una sola ruta: los indicadores caben en una respuesta compacta.

### 4.1 Conteos

| Grupo | Campos |
|---|---|
| `properties` | `total`, `active` |
| `obligations` | `active` (definiciones), `periodsPending` (abiertos que aún no vencen), `periodsOverdue`, `periodsDueSoon` (abiertos dentro del umbral, incluido hoy), `periodsConfirmed` (`paid`/`attended`) |
| `rentCharges` | `pending`, `overdue`, `dueSoon`, `received` |
| `contracts` | `active`, `endingSoon`, `endPassed` |
| `hitl` | `pending` (pendientes con plazo vigente) |
| `alerts` | `active` (vigentes), `unread` (vigentes sin leer) |
| `cases` | `open` (no `completed`/`failed`/`cancelled`) |

"Vencido" se calcula por fecha (`due_date < hoy`) sobre registros abiertos, aunque el estado almacenado siga en `pending`.

### 4.2 Montos

```json
"money": {
  "note": "Valores esperados y confirmaciones declaradas por el usuario. No son saldos bancarios ni pagos verificados.",
  "obligationsOpen": [{ "currency": "COP", "total": "185000.75", "count": 5, "withoutAmount": 1 }],
  "rentOpen":        [{ "currency": "COP", "total": "3600000.00", "count": 3, "withoutAmount": 0 }],
  "month": { "start": "2026-11-01", "end": "2026-12-01" },
  "obligationsThisMonth": [{ "currency": "COP", "expected": "…", "confirmed": "…" }],
  "rentThisMonth":        [{ "currency": "COP", "expected": "…", "received": "…" }]
}
```

- **Esperado ≠ recibido/pagado.** `expected` suma registros no anulados del mes (por fecha de vencimiento); `confirmed`/`received` suma solo los que el usuario confirmó con los endpoints humanos. Ningún valor es un saldo bancario.
- **Una fila por moneda.** Nunca se suman monedas distintas ni se convierte.
- **Decimales exactos:** `SUM` sobre `numeric(14,2)` en PostgreSQL, devuelto como texto (`round(…, 2)::text`). Nunca `float`.
- `withoutAmount` cuenta períodos sin valor conocido (no suman).

### 4.3 Aislamiento y rendimiento

- Todas las agregaciones filtran por el propietario del JWT. Un usuario sin datos obtiene ceros y listas vacías.
- 5 consultas en paralelo: una con subconsultas escalares `count(*)` y cuatro `GROUP BY currency`. Ninguna trae filas a memoria para contarlas.
- Usan los índices existentes `(owner_id, due_date)` de períodos y cobros, `(owner_id, ends_on)` de contratos, `(owner_id, status)` de casos, `(assigned_to, status)` de HITL y los nuevos de `alerts`. No se añadieron índices a tablas existentes. Sin caché.

## 5. Seguridad

- Rutas de usuario: JWT obligatorio; el propietario sale de `@CurrentUser()`; `ownerId` o campos no declarados → 400; recursos ajenos → 404.
- Ruta interna: solo token de servicio; un JWT de usuario → 401. El token de servicio no sirve en rutas de usuario (401).
- Todas las consultas SQL son parametrizadas; ningún identificador (tabla o columna) proviene del cliente.
- Las consultas GET no escriben (verificado en pruebas comparando conteos y `updated_at`).

## Evaluaciones concurrentes (Fase 4.2F.2)

Comprobado en PostgreSQL 18 local con conexiones independientes ([resultados](../testing/postgres-concurrency-results.md)).

- **Serialización:** las fases del barrido bloquean alertas en órdenes distintos, y eso producía interbloqueos (40P01, respondidos como 409). Ahora cada lote toma `pg_advisory_xact_lock`: los lotes de barridos simultáneos se ejecutan de uno en uno.
- **Operación recomendada:** un solo scheduler. Un barrido en espera ocupa una conexión del pool.
- **Confirmar durante un barrido:** puede quedar una alerta `active` almacenada hasta el siguiente barrido, pero la vista de usuario ya la muestra resuelta, porque el estado efectivo se calcula al consultar.
- **Consultas:** los GET no escriben; la huella de alertas, auditoría y períodos no cambia.
