# Integración NestJS ↔ n8n: casos, propuestas, HITL y cola de trabajos (Fase 4.2C)

Este documento describe los mecanismos internos del backend que usarán los workflows de n8n (y, a través de ellos, Gmail, IA y STT). **En esta fase no hay n8n instalado ni servicios externos conectados**; el comportamiento se verifica con un cliente HTTP que simula al worker.

> **Principio:** la IA propone, las reglas validan y el backend ejecuta solo operaciones autorizadas. n8n nunca accede a PostgreSQL y ninguna ruta interna puede confirmar pagos, marcar cobros como recibidos, renovar contratos ni modificar obligaciones.

## 1. Arquitectura

```
Usuario ──JWT──▶ NestJS ──▶ PostgreSQL (Neon)
                   ▲
n8n ──token de servicio──┘   (polling HTTPS; sin acceso a la base)
```

1. El usuario crea un **caso** (`POST /cases`). En la misma transacción se crea su **trabajo** inicial y la auditoría.
2. n8n consulta periódicamente `POST /internal/workflow-jobs/claim` y obtiene trabajos con un **token de reclamación**.
3. n8n procesa el trabajo con sus integraciones (fases posteriores) y devuelve resultados mediante rutas internas: **propuestas**, **solicitudes HITL**, `complete`/`fail`.
4. El usuario revisa y decide (`POST /hitl-requests/:id/decision`). La decisión genera un trabajo `hitl.decision` que n8n recogerá por polling.
5. Aplicar datos aprobados a tablas financieras requerirá operaciones de negocio específicas (pendiente, ver §16).

## 2. Autenticación del servicio

| Aspecto | Implementación |
|---|---|
| Credencial | `Authorization: Bearer <N8N_SERVICE_TOKEN>` |
| Origen | Variable de entorno `N8N_SERVICE_TOKEN` (≥ 43 caracteres aleatorios, distinta de `JWT_SECRET`; obligatoria en producción). Nunca en URLs, logs ni Swagger |
| Comparación | SHA-256 de ambos valores + `timingSafeEqual` (tiempo constante, sin revelar longitud) |
| Sin token configurado | Toda solicitud interna responde 401 |
| Identidad | `request.service = { name: 'n8n' }`; **nunca** se crea un `request.user` |

El guard global distingue tres clases de rutas, en este orden:

1. **`@ServiceRoute()`** (todas las rutas `/internal/*`): solo el token de servicio. Un JWT de usuario responde 401. Prevalece sobre `@Public()`, así que una ruta interna no puede quedar abierta por error.
2. **`@Public()`**: solo `GET /health` y `POST /auth/login`.
3. **Resto**: JWT de usuario. El token de servicio no sirve como usuario (401).

Una prueba recorre el documento de Swagger y exige que toda ruta `/internal/*` declare solo el esquema `service` y el resto solo `bearer`.

Generar el token localmente:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 3. Endpoints

### De usuario (JWT)

| Método | Ruta | Función |
|---|---|---|
| GET | `/api/v1/cases` | Listar casos propios (filtros `status`, `type`; más recientes primero) |
| GET | `/api/v1/cases/:id` | Consultar un caso propio |
| POST | `/api/v1/cases` | Crear un caso y su trabajo inicial (201; 200 si es repetición por `requestId`) |
| GET | `/api/v1/cases/:id/proposals` | Propuestas del caso por versión (filtro `reviewStatus`) |
| GET | `/api/v1/hitl-requests` | Revisiones asignadas (filtros `status`, `caseId`) |
| GET | `/api/v1/hitl-requests/:id` | Revisión con su propuesta vinculada |
| POST | `/api/v1/hitl-requests/:id/decision` | Aprobar o rechazar |
| POST | `/api/v1/cases/:caseId/proposals/:proposalId/apply` | Aplicar una propuesta aprobada (acciones permitidas; ver [proposal-application.md](proposal-application.md)) |

### Internas (token de servicio)

| Método | Ruta | Función |
|---|---|---|
| POST | `/api/v1/internal/workflow-jobs/claim` | Reclamar un lote de trabajos |
| GET | `/api/v1/internal/workflow-jobs/:id` | Detalle (cabecera `X-Claim-Token`) |
| POST | `/api/v1/internal/workflow-jobs/:id/heartbeat` | Renovar el arrendamiento |
| POST | `/api/v1/internal/workflow-jobs/:id/complete` | Finalizar el trabajo |
| POST | `/api/v1/internal/workflow-jobs/:id/fail` | Registrar un fallo |
| POST | `/api/v1/internal/cases/:id/proposals` | Registrar una propuesta |
| POST | `/api/v1/internal/cases/:id/hitl-requests` | Solicitar revisión humana |
| POST | `/api/v1/internal/cases/:id/complete` | Cerrar el caso como completado |
| POST | `/api/v1/internal/cases/:id/fail` | Cerrar el caso como fallido |
| POST | `/api/v1/internal/hitl-requests/expire` | Materializar vencimientos HITL |
| POST | `/api/v1/internal/alerts/evaluate` | Evaluar vencimientos y sincronizar alertas internas (ver [alerts-and-dashboard.md](alerts-and-dashboard.md#25-evaluación-interna-token-de-servicio)) |

No existe una ruta para crear trabajos libremente ni un PATCH genérico de estados. Las cuatro rutas `/internal/cases/:id/*` exigen `jobId` + `claimToken` de una **reclamación vigente de un trabajo de ese mismo caso**: el servicio solo escribe en casos que está procesando, y el propietario sale del caso en PostgreSQL.

## 4. Ejemplos HTTP (valores ficticios)

```bash
API=http://localhost:3000/api/v1
SERVICE="Authorization: Bearer $N8N_SERVICE_TOKEN"   # nunca en la URL

# Reclamar hasta 5 trabajos con arrendamiento de 5 minutos
curl -X POST $API/internal/workflow-jobs/claim -H "$SERVICE" -H 'Content-Type: application/json' \
  -d '{"workerId":"n8n-local-1","limit":5,"leaseSeconds":300}'
```

```json
{
  "jobs": [{
    "id": "0b6f…", "jobType": "case.household_obligation", "status": "claimed",
    "payload": { "caseType": "household_obligation", "source": "form", "obligationId": "7c1e…" },
    "attempts": 1, "maxAttempts": 5, "availableAt": "…", "workerId": "n8n-local-1",
    "lockedUntil": "2026-11-03T15:05:00.000Z", "result": null, "lastError": null, "completedAt": null,
    "case": { "id": "41d2…", "correlationId": "9a8b…", "type": "household_obligation",
              "source": "form", "status": "processing", "obligationId": "7c1e…",
              "rentalId": null, "contractId": null },
    "claimToken": "<token de 43 caracteres>"
  }]
}
```

```bash
# Registrar una propuesta extraída por el modelo
curl -X POST $API/internal/cases/41d2…/proposals -H "$SERVICE" -H 'Content-Type: application/json' \
  -d '{"jobId":"0b6f…","claimToken":"<token>","source":"llm",
       "proposedData":{"amount":"145000.00","dueDate":"2026-11-18"},"confidence":"0.870"}'

# Pedir revisión humana con dos alternativas
curl -X POST $API/internal/cases/41d2…/hitl-requests -H "$SERVICE" -H 'Content-Type: application/json' \
  -d '{"jobId":"0b6f…","claimToken":"<token>","decisionType":"data_confirmation","proposalId":"<uuid>",
       "options":{"summary":"La factura muestra dos valores","choices":[{"key":"amount_a","label":"$145.000"},{"key":"amount_b","label":"$154.000"}]}}'

# Finalizar el trabajo
curl -X POST $API/internal/workflow-jobs/0b6f…/complete -H "$SERVICE" -H 'Content-Type: application/json' \
  -d '{"claimToken":"<token>","result":{"summary":"Propuesta registrada y revisión solicitada"}}'

# El usuario decide (JWT de usuario)
curl -X POST $API/hitl-requests/<id>/decision -H "Authorization: Bearer $USER_JWT" -H 'Content-Type: application/json' \
  -d '{"decision":"approved","choice":"amount_a","comment":"El valor correcto es el primero"}'
```

## 5. Contratos de solicitud

| Operación | Cuerpo | Límites |
|---|---|---|
| `POST /cases` | `type` (`household_obligation`, `rent_collection`, `contract_review`); opcional **una** entidad acorde al tipo (`obligationId`, `rentalId` o `contractId`, propia); opcional `requestId` (UUID) | No acepta `status`, `source`, `ownerId` ni `correlationId` (400) |
| `claim` | `workerId` (`[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`), `limit` 1–10 (5), `leaseSeconds` 30–900 (300), `jobTypes[]` | — |
| `heartbeat` | `claimToken`, `leaseSeconds` | — |
| `complete` | `claimToken`, `result` (objeto) | `result` ≤ 16 KB |
| `fail` | `claimToken`, `error`, `retryable` (true) | `error` se sanea y trunca a 500 caracteres |
| `proposals` | `jobId`, `claimToken`, `source` (`llm`, `ocr`, `stt`), `proposedData` (objeto), `evidence`, `confidence` (`"0"`–`"1"`, 3 decimales), `documentId` | `proposedData` ≤ 16 KB, `evidence` ≤ 8 KB |
| `hitl-requests` | `jobId`, `claimToken`, `decisionType`, `proposalId`, `options` { `summary`, `choices[]` { `key`, `label` }, `context` } | ≤ 10 alternativas con claves únicas; `context` ≤ 4 KB |
| `cases/:id/complete` | `jobId`, `claimToken` | — |
| `cases/:id/fail` | `jobId`, `claimToken`, `reason` | `reason` ≤ 500, saneado |
| `expire` | `workerId`, `limit` 1–100 (50) | — |
| `decision` | `decision` (`approved`, `rejected`), `choice`, `comment` | Aprobar con alternativas exige `choice`; rechazar no admite `choice` |

El `ValidationPipe` global rechaza cualquier propiedad no declarada (`ownerId`, `assignedTo`, `dueAt`, `respondedAt`, `reviewStatus`, `version`, `status`…).

Las respuestas nunca incluyen `ownerId`. Las internas tampoco exponen datos personales del usuario.

## 6. Flujo de un caso

1. `POST /cases` crea el caso con `status = received`, `source = form`, un `correlation_id` UUID generado por el servidor (también en la cabecera `X-Correlation-Id`) y un trabajo `case.<tipo>` con payload mínimo. Caso, trabajo y dos eventos de auditoría se escriben en **una transacción**.
2. **Idempotencia:** con `requestId`, la clave del trabajo es `case-request:<propietario>:<requestId>` (única en la tabla). Repetirla devuelve el mismo caso con 200. Dos solicitudes simultáneas producen un solo caso. Reutilizar la clave con otros datos responde 409.
3. La primera reclamación de un trabajo pasa el caso a `processing`.
4. Solo se aceptan entidades propias (una ajena responde 404, igual que una inexistente).
5. Los casos de origen `document`, `gmail` o `voice` los crean los flujos de ingesta ([ingestion-api.md](ingestion-api.md)).

## 7. Flujo de una propuesta

- Cada propuesta es una **nueva versión** (`max + 1`, con el caso bloqueado) en `pending_review`.
- Un reintento con el mismo contenido que **cualquier** versión anterior del caso (`jsonb` igual, aunque cambie el orden de claves) devuelve esa versión con 200, con su estado actual (p. ej. `superseded`). Una respuesta tardía o fuera de orden nunca recrea ni reactiva una versión reemplazada (Fase 4.2F.1).
- Una versión nueva marca las anteriores pendientes como `superseded`. Las revisiones HITL pendientes ligadas a ellas se anulan (`cancelled`); si el caso queda sin revisiones pendientes, vuelve a `processing`.
- **Guardar una propuesta no la aprueba ni modifica datos de negocio.** La auditoría registra `appliedToBusinessData: false` y el tamaño, nunca el contenido.

## 8. Flujo de aprobación humana

1. El servicio crea la solicitud: `assigned_to = owner_id = propietario del caso`, `due_at = now() + 24 h` (valor por defecto de la columna). El caso pasa a `awaiting_human`.
2. Un reintento idéntico devuelve la solicitud pendiente existente con 200.
3. El usuario consulta `GET /hitl-requests` y el detalle con la propuesta vinculada. El campo `overdue` indica si ya pasó la fecha límite.
4. La decisión:
   - Bloquea caso y solicitud, en ese orden.
   - Exige estado `pending` y `due_at > clock_timestamp()`, evaluado con el bloqueo ya tomado: una decisión retenida más allá del plazo se rechaza.
   - Registra `decision` (`outcome`, `choice`, `comment`) y `responded_at = clock_timestamp()` (servidor) con un `UPDATE … WHERE status = 'pending' AND due_at > clock_timestamp()`.
   - Audita con el usuario como actor.
5. **Aprobar** marca la propuesta `accepted`; si ya fue reemplazada, 409 y no se registra nada. **Rechazar** la marca `rejected`. Ninguna de las dos aplica datos financieros.
6. Si no quedan revisiones pendientes, el caso vuelve a `processing`, y se crea el trabajo `hitl.decision` (clave `hitl-decision:<id>`) para que n8n continúe.

| Situación | Respuesta |
|---|---|
| Primera decisión | 200 |
| Misma decisión repetida (mismo `decision` y `choice`) | 200, sin cambios ni nuevo evento |
| Decisión distinta de la registrada | 409 |
| Solicitud vencida, anulada o propuesta reemplazada | 409 |
| Solicitud de otro usuario | 404 |

## 9. Vencimiento HITL (SLA de 24 horas)

- **El vencimiento nunca es una aprobación.**
- El endpoint de decisión compara `due_at` con el reloj de PostgreSQL (`clock_timestamp()`) aunque nadie haya materializado el vencimiento. Si ya pasó, marca la solicitud `expired`, lo audita (`hitl_request.expire`, actor `system`), confirma ese cambio y responde 409. `decision` y `responded_at` quedan nulos.
- `POST /internal/hitl-requests/expire` permite que un workflow programado materialice los vencimientos. Procesa cada solicitud en su propia transacción y omite las que se decidieron mientras tanto.
- Si el caso queda sin revisiones pendientes, se **detiene**: pasa a `failed` con el motivo "La revisión humana venció sin decisión". Un proceso sensible no continúa sin decisión humana.
- No hay cron en el backend.

## 10. Reclamación y finalización de trabajos

**Reclamación** (una transacción):

1. Falla, en una transacción propia, los trabajos con arrendamiento vencido y sin intentos restantes.
2. Selecciona trabajos `pending` con `available_at <= now()`, o `claimed` con arrendamiento vencido, con `attempts < max_attempts` y caso abierto.
3. Ordena por `available_at, id`, aplica `LIMIT` y bloquea con `FOR UPDATE OF workflow_jobs SKIP LOCKED`.
4. Por cada trabajo: `status = claimed`, `attempts + 1`, `locked_until = now() + lease`, y un token nuevo.

Solo se devuelven los trabajos realmente reclamados.

**Token de reclamación (fencing sin migración).** El esquema no tiene una columna para el identificador de reclamación, así que:

- El servidor genera 32 bytes aleatorios por reclamación y los entrega una sola vez.
- `locked_by` guarda `<workerId>#<sha256(token)>`; el token en claro nunca se almacena.
- Una nueva reclamación reemplaza la huella. Una respuesta tardía de la reclamación anterior, incluso del mismo worker, ya no coincide y recibe 409.
- Al completar o fallar se conserva `locked_by` y se limpia `locked_until`, como permite el check `workflow_jobs_lease`. Así se reconoce un `complete` o `fail` duplicado de la misma reclamación.
- La verificación usa `timingSafeEqual`.

**complete:**

- Exige la reclamación vigente con el arrendamiento activo **en el instante en que se obtiene el bloqueo** (`clock_timestamp()`, no `now()`). Lo mismo aplica a `heartbeat`, `fail`, propuestas, revisiones, cierre de caso y lectura de documentos; en las rutas de casos se revalida también tras obtener el bloqueo del caso.
- Usa un `UPDATE` condicionado a `status`, `locked_by` y `locked_until > clock_timestamp()`.
- Una repetición de un trabajo ya completado no comprueba el arrendamiento: un reintento idéntico sigue siendo 200 aunque haya pasado el tiempo.
- Guarda `result` y `completed_at`.
- **Completar no confirma pagos, cobros ni contratos, ni aprueba propuestas.**

**heartbeat:** extiende `locked_until` si la reclamación sigue vigente. No se audita porque no cambia el estado.

## 11. Reintentos e idempotencia

| Operación | Política |
|---|---|
| Intentos | Se cuentan **al reclamar**, así que un worker que muere también consume un intento. El check `attempts <= max_attempts` (por defecto 5) evita bucles infinitos |
| `fail` con `retryable` (por defecto) e intentos restantes | `pending` con `available_at = now() + 30 s · 2^(intentos-1)`, máximo 1 h |
| `fail` sin intentos o con `retryable: false` | `failed`; el caso se cierra como `failed` |
| Arrendamiento vencido sin respuesta | Se puede volver a reclamar si quedan intentos; si no, se marca `failed` en la siguiente reclamación |
| `complete` duplicado **idéntico** (misma reclamación) | 200 con el resultado ya guardado, sin nueva transición ni evento. Se compara como `jsonb`: el orden de las claves no importa; valores, tipos y orden de arreglos sí. Omitir `result` equivale a `{}` |
| `complete` duplicado **contradictorio** | **409**; el resultado, el estado y la auditoría no cambian |
| `complete` de una reclamación antigua, o de un trabajo fallido o anulado | 409, aunque el resultado coincida |
| `fail` duplicado (misma reclamación) | 200 con el estado actual; **no** incrementa intentos ni audita |
| `complete`/`fail` con una reclamación antigua o un token inválido | 409 |
| Creación de caso, propuesta o revisión repetida | Ver §6, §7 y §8 |

Los errores se sanean antes de guardarse: se eliminan caracteres de control y se redactan `Bearer …`, `password=…`, `token: …`, `api_key…`, credenciales en URLs, correos y cadenas largas tipo clave. El resultado se trunca a 500 caracteres.

## 12. Matriz de estados y transiciones

**Casos (`case_status`)**

| Desde → hacia | Acción | Actor |
|---|---|---|
| — → `received` | `POST /cases` | Usuario |
| `received` → `processing` | Primera reclamación de un trabajo del caso | Servicio |
| `received`/`processing` → `awaiting_human` | `POST /internal/cases/:id/hitl-requests` | Servicio |
| `awaiting_human` → `processing` | Última revisión pendiente decidida, o anulada por una propuesta nueva | Usuario / servicio |
| `received`/`processing` → `completed` | `POST /internal/cases/:id/complete`, sin revisiones pendientes | Servicio |
| no final → `failed` | `POST /internal/cases/:id/fail`; trabajo fallido definitivamente; revisión vencida sin otras pendientes | Servicio / sistema |
| — → `cancelled` | Sin transición en esta fase (cancelación por el usuario pendiente) | — |

Al cerrar un caso (`completed` o `failed`) se anulan sus revisiones pendientes y sus trabajos aún no reclamados (`SKIP LOCKED`). `closed_at` se fija con `now()`.

**Propuestas (`proposal_review_status`):** `pending_review` → `accepted` (aprobación HITL) · `rejected` (rechazo HITL) · `superseded` (nueva versión). Los estados finales no cambian.

**Revisiones (`hitl_status`):** `pending` → `approved` / `rejected` (usuario, antes de `due_at`) · `expired` (fecha límite cumplida: decisión tardía o barrido) · `cancelled` (propuesta reemplazada o caso cerrado). Ningún estado final pasa a `approved`.

**Trabajos (`job_status`)**

| Desde → hacia | Acción |
|---|---|
| `pending` → `claimed` | `claim` |
| `claimed` (arrendamiento vencido) → `claimed` | `claim` de otro worker, con nueva huella |
| `claimed` → `completed` | `complete` |
| `claimed` → `pending` | `fail` con reintento |
| `claimed` → `failed` | `fail` definitivo, o arrendamiento vencido sin intentos |
| `pending` → `cancelled` | Cierre del caso |

## 13. Formatos de error

Todos los errores usan el formato estándar de Nest:

```json
{ "statusCode": 409, "message": "La reclamación no es válida o fue reemplazada por otra", "error": "Conflict" }
```

| Código | Situaciones |
|---|---|
| 400 | Validación, propiedades no permitidas, falta `X-Claim-Token`, alternativa inválida |
| 401 | Token ausente o inválido; JWT en una ruta interna; token de servicio en una ruta de usuario |
| 404 | Caso, trabajo, revisión o entidad inexistente o ajena; trabajo de otro caso |
| 409 | Reclamación inválida o vencida; estado incompatible; decisión contradictoria; solicitud vencida; `requestId` reutilizado; conflicto de concurrencia (`40001`, `40P01`, `55P03`), en cuyo caso se puede reintentar |
| 503 | PostgreSQL no disponible |

Nunca se exponen SQL, nombres internos ni secretos.

## 14. `correlation_id`

- Cada caso tiene un `correlation_id` UUID único, generado por el servidor.
- Todos los eventos del proceso usan ese mismo identificador: `case.create`, `workflow_job.create/claim/complete/fail/cancel`, `case.status_change`, `case_proposal.create/supersede/accept/reject`, `hitl_request.create/approve/reject/expire/cancel`. Así se puede reconstruir la cadena **caso → trabajo → propuesta → revisión → decisión**.
- Los trabajos exponen `case.correlationId` para que n8n lo propague en sus logs.

Actores en `audit_events`:

| Actor | `actor_type` | `actor_id` |
|---|---|---|
| Usuario | `user` | perfil |
| Worker de n8n | `workflow` | `n8n:<workerId>` |
| Reglas internas (vencimiento al decidir, cierres en cascada) | `system` | `api` |

Cada transición y su auditoría se escriben en la misma transacción; si la auditoría falla, nada se confirma. Las pruebas lo verifican forzando el fallo.

## 15. Restricciones de seguridad

- **Sin acceso a la base:** n8n no tiene credenciales de PostgreSQL.
- **Alcance por reclamación:** el servicio solo escribe en casos con una reclamación vigente de uno de sus trabajos. No hay endpoints administrativos universales ni forma de elegir el propietario.
- **Datos financieros intactos:** ninguna ruta interna, propuesta, resultado de trabajo ni aprobación HITL modifica obligaciones, períodos, cobros o contratos (verificado en pruebas).
- **Tamaños acotados:** los campos `jsonb` tienen límite de tamaño y el cuerpo HTTP queda limitado por Express a 100 KB.
- **Secretos protegidos:** el token de servicio y los tokens de reclamación no aparecen en logs, Swagger ni auditoría.
- **Orden de bloqueo único:** trabajo → caso → propuestas/revisiones, para evitar interbloqueos.

## 16. Limitaciones y pendientes

- **Concurrencia real:** comprobada en PostgreSQL 18 local con conexiones independientes ([resultados](../testing/postgres-concurrency-results.md)). Falta comprobarla a través del pooler de Neon.
- **`locked_by` con dos funciones:** guarda la huella de la última reclamación también después de completar o fallar. Es seguro y no requiere migración. Una columna dedicada (`claim_token_hash`) sería una mejora opcional de claridad.
- **Aplicación de propuestas aprobadas (Fase 4.2E):** solo la ejecuta el usuario autenticado con `POST /cases/:caseId/proposals/:proposalId/apply`, para una lista cerrada de acciones y exactamente una vez ([proposal-application.md](proposal-application.md)). El trabajo `hitl.decision` sigue siendo solo informativo: completarlo no aplica datos.
- **Sin cancelación de casos por el usuario:** existe el estado `cancelled`, pero no tiene endpoint.
- **Ingesta:** desde la Fase 4.2D existen los casos de origen `document` y `voice`, con los trabajos `document.process` y `voice.transcribe` y la lectura de archivos por el worker ([ingestion-api.md](ingestion-api.md)). El origen `gmail` solo se admite para los buzones vinculados en `GMAIL_MAILBOX_LINKS` (§11 de ese documento).
- **Sin workflows de n8n:** no hay archivos de workflows, Docker ni conexión con IA o FCM.
- **Credencial compartida:** el token de servicio es único. La rotación requiere reiniciar el backend con el nuevo valor.
- **Rol de base de datos:** la API sigue usando `neondb_owner`. La activación de `notihouse_app` está en [mvp-demo-setup.md](../deployment/mvp-demo-setup.md#3-neon).

## Notas para el workflow de n8n (Fase 4.2F.2)

Comprobado con un cliente HTTP simulado sobre PostgreSQL 18 real; n8n no está conectado ([resultados](../testing/postgres-concurrency-results.md)).

- **Orden de cierre:** llama a `cases/:id/complete` **antes** de `workflow-jobs/:id/complete`, porque el primero exige una reclamación vigente.
- **Reintentos de `complete`:** reenvía exactamente el mismo cuerpo. Un 409 en un reintento revela un error del workflow y no debe ignorarse.
- **Casos cerrados durante una reclamación:** su trabajo no se entrega y pasa a `cancelled`, con un evento `workflow_job.cancel`.
- **Varios workers:** los casos de un lote se bloquean por id, de modo que pueden reclamar a la vez sin interbloquearse.
- **Notas de voz:** una propuesta `stt` aprobada no se aplica. El workflow debe generar después una propuesta `llm` con una acción permitida.

## Contrato para n8n contra Render (Fase 4.2F.3)

n8n en Docker, en un equipo del proyecto, consulta la API de Render por HTTPS con `Authorization: Bearer <N8N_SERVICE_TOKEN>`. Solo hace solicitudes salientes: no hay que publicar su puerto. Conexión: [mvp-demo-setup.md](../deployment/mvp-demo-setup.md#7-conectar-n8n-local-fase-posterior).

Los workflows reales aún no existen. Este contrato se comprobó con un cliente HTTP simulado sobre la API de producción en contenedor, PostgreSQL 18 local y S3 local.

### Respuestas que el workflow debe respetar

| Situación | Respuesta | Qué hacer |
|---|---|---|
| `complete` idéntico repetido | 200, idempotente | Nada |
| `complete` contradictorio | 409 | Es un error del workflow; no se ignora |
| Reclamación vencida | 409 | Volver a reclamar; no continuar |
| Worker antiguo, tras una nueva reclamación | 409 | Abandonar ese trabajo |
| Propuesta antigua reenviada | 200 con su estado real (`superseded`); no revive | Usar la versión vigente |
| HITL vencida | Nunca aprueba: 409 al decidir y el caso se detiene | Crear un caso nuevo si hace falta |
| Aplicación de propuesta | Solo el usuario, con JWT, tras aprobación humana. El token de servicio recibe 401 | n8n nunca la llama |
| Confirmación financiera | No existe ruta interna ni acción permitida. Aplicar crea un período `pending`, nunca un pago | El usuario confirma aparte |
| Propuesta `stt` | 400 al aplicar, aunque esté aprobada y tenga forma de acción permitida | Registrar una propuesta `llm` |

### Flujo PDF

PDF → caso → trabajo → procesamiento externo → propuesta → HITL → aplicación → actualización de alertas.

1. El usuario sube el PDF (`POST /ingestions/documents`). Se crean el caso y el trabajo `document.process`.
2. n8n: `POST /internal/workflow-jobs/claim` con `jobTypes: ["document.process"]`.
3. n8n: `GET /internal/documents/:documentId/content` con `X-Job-Id` y `X-Claim-Token`. Si tarda, `heartbeat`.
4. n8n procesa el archivo fuera del backend y envía `POST /internal/cases/:id/proposals`, con `source: "llm"` u `"ocr"` y `proposedData: { action, data }`.
5. n8n: `POST /internal/cases/:id/hitl-requests` con `decisionType: "data_confirmation"`, sin `choices`: con alternativas, la propuesta no se puede aplicar.
6. n8n: `POST /internal/workflow-jobs/:id/complete`.
7. El usuario decide (`POST /hitl-requests/:id/decision`) y aplica (`POST /cases/:caseId/proposals/:proposalId/apply`).
8. n8n reclama `hitl.decision` y cierra (ver *Cierre de casos*).
9. La siguiente evaluación programada actualiza las alertas.

### Flujo de voz

Audio → STT → texto → interpretación LLM → propuesta → HITL → aplicación.

1. El usuario sube el audio (`POST /ingestions/voice`). Se crea el trabajo `voice.transcribe`.
2. n8n reclama `voice.transcribe`, lee el audio igual que el PDF y lo envía al servicio STT.
3. Opcional: registra el texto con `source: "stt"`, solo como evidencia. **No se aplica nunca.**
4. n8n interpreta el texto con el LLM y registra `source: "llm"` con `{ action, data }`. Esa versión reemplaza a la anterior.
5. Continúa como el flujo PDF desde el paso 5, sobre la versión `llm`.

### Cierre de casos

Orden comprobado en PostgreSQL real:

1. `POST /internal/cases/:id/complete`, mientras la reclamación esté vigente.
2. `POST /internal/workflow-jobs/:id/complete`.

### Alertas

Un **único** scheduler llama a `POST /internal/alerts/evaluate`, como máximo una vez por hora. No lo dupliques en varios workflows.
