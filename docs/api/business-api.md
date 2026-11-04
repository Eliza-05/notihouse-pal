# API de negocio: inmuebles, obligaciones, arriendos y contratos (Fases 4.2A y 4.2B)

API REST para que un usuario autenticado administre sus inmuebles, las definiciones de sus obligaciones recurrentes del hogar, los períodos concretos de cada obligación y la confirmación manual de pago o atención.

> **Alcance:** las secciones 1 a 9 cubren el proceso A (obligaciones del hogar) e inmuebles, de la Fase 4.2A. La sección 10 cubre los procesos B y C (arriendos, cobros y contratos), de la Fase 4.2B. IA, voz, Gmail, FCM y workflows de n8n **no** están implementados. Tampoco existe generación automática de períodos o cobros, confirmación automática ni vencimiento o renovación automática de contratos.

Prefijo: `/api/v1`. Todas las rutas requieren `Authorization: Bearer <token>` (ver [autenticación](../architecture/authentication.md)). Documentación interactiva en Swagger: `/api/docs` (solo fuera de producción).

## 1. Endpoints

### Inmuebles

| Método | Ruta | Función | Éxito |
|---|---|---|---|
| GET | `/properties` | Listar inmuebles propios (paginado, filtro `status`) | 200 |
| GET | `/properties/:id` | Consultar un inmueble propio | 200 |
| POST | `/properties` | Crear inmueble (siempre `active`) | 201 |
| PATCH | `/properties/:id` | Editar `name`, `address`, `description`, `status` | 200 |

### Obligaciones (definición recurrente)

| Método | Ruta | Función | Éxito |
|---|---|---|---|
| GET | `/obligations` | Listar obligaciones propias (filtros `propertyId`, `status`, `category`) | 200 |
| GET | `/obligations/:id` | Consultar una obligación propia | 200 |
| POST | `/obligations` | Crear obligación, con o sin inmueble propio | 201 |
| PATCH | `/obligations/:id` | Editar la definición (no modifica los períodos) | 200 |

### Períodos de una obligación

| Método | Ruta | Función | Éxito |
|---|---|---|---|
| GET | `/obligations/:id/occurrences` | Listar períodos ordenados por vencimiento (filtro `status`) | 200 |
| GET | `/obligations/:id/occurrences/:occurrenceId` | Consultar un período | 200 |
| POST | `/obligations/:id/occurrences` | Crear un período (siempre `pending`) | 201 |
| PATCH | `/obligations/:id/occurrences/:occurrenceId` | Editar un período pendiente o vencido, o anularlo | 200 |
| POST | `/obligations/:id/occurrences/:occurrenceId/confirm` | **Confirmación humana** de pago o atención | 200 |

No hay rutas `DELETE`. Los registros se desactivan por estado (sección 4).

## 2. Formatos

- **Identificadores:** UUID. Un UUID mal formado en la ruta devuelve 400.
- **Dinero:** **cadena decimal** sin signo, con hasta 12 dígitos enteros y 2 decimales (`"145000"`, `"145000.50"`). Corresponde a `numeric(14,2)` y nunca se acepta como número JSON, para no perder precisión. Las respuestas siempre llevan 2 decimales (`"145000.00"`).
- **Moneda:** código ISO 4217 de 3 letras mayúsculas, por defecto `COP`. No se puede cambiar después de crear la obligación.
- **Fechas de calendario:** `YYYY-MM-DD`, que deben existir realmente (se rechaza `2026-02-30`).
- **Marcas de tiempo** (`createdAt`, `updatedAt`, `confirmedAt`): ISO 8601 en UTC, asignadas por el servidor.
- **Propietario:** las respuestas no incluyen `ownerId`. Ningún DTO lo acepta, y el `ValidationPipe` global rechaza con 400 cualquier propiedad no declarada (`ownerId`, `confirmedBy`, `confirmedAt`, `currency` en un PATCH, etc.).

### Ejemplos

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"laura.martinez@notihouse.com","password":"<contraseña>"}' | jq -r .accessToken)

# Crear una obligación asociada a un inmueble propio
curl -X POST http://localhost:3000/api/v1/obligations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"propertyId":"<uuid>","providerName":"Empresa de gas","concept":"Gas natural",
       "category":"gas","expectedAmount":"62000.00","frequency":"monthly","dueDay":12}'

# Registrar el período de noviembre (monto copiado del valor esperado)
curl -X POST http://localhost:3000/api/v1/obligations/<obligationId>/occurrences \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"periodStart":"2026-11-01","periodEnd":"2026-11-30","dueDate":"2026-11-12"}'

# Confirmar manualmente que se pagó
curl -X POST http://localhost:3000/api/v1/obligations/<obligationId>/occurrences/<occurrenceId>/confirm \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"result":"paid","reference":"Comprobante 123"}'
```

Respuesta de un período confirmado:

```json
{
  "id": "…", "obligationId": "…",
  "periodStart": "2026-11-01", "periodEnd": "2026-11-30", "dueDate": "2026-11-12",
  "amount": "62000.00", "currency": "COP", "status": "paid",
  "confirmedAt": "2026-11-10T14:03:22.511Z", "confirmedBy": "<uuid del usuario>",
  "confirmationReference": "Comprobante 123",
  "createdAt": "…", "updatedAt": "…"
}
```

## 3. Paginación y filtros

| Parámetro | Valores | Por defecto |
|---|---|---|
| `page` | entero ≥ 1 | 1 |
| `pageSize` | entero entre 1 y **100** | 20 |

Todos los listados responden con la misma forma:

```json
{ "items": [ … ], "page": 1, "pageSize": 20, "total": 3 }
```

| Recurso | Orden estable | Filtros |
|---|---|---|
| Inmuebles | `created_at`, `id` | `status` (`active`, `inactive`, `archived`) |
| Obligaciones | `created_at`, `id` | `propertyId`, `status` (`active`, `paused`, `archived`), `category` |
| Períodos | `due_date`, `period_start`, `id` | `status` (`pending`, `overdue`, `paid`, `attended`, `cancelled`) |

Los filtros siempre se combinan con el propietario autenticado: filtrar por el `propertyId` de otro usuario devuelve una lista vacía, sin revelar nada. Un valor de filtro inválido devuelve 400.

## 4. Reglas de negocio

### Inmuebles
- **Nombre:** obligatorio (1 a 120 caracteres tras recortar espacios) y único por propietario (409 si se repite). Dos usuarios pueden usar el mismo nombre.
- **Desactivación:** se hace con `PATCH {"status":"inactive"}` o `"archived"`. No hay borrado físico, porque eliminar un inmueble con obligaciones rompería el historial (las FKs usan `ON DELETE RESTRICT`).
- **Asociaciones:** solo un inmueble `active` puede asociarse a una obligación nueva o editada (409 si no lo está).

### Obligaciones
- **Validaciones de creación:** `providerName`, `concept`, `category` (`water`, `electricity`, `gas`, `internet`, `mobile`, `administration`, `other`), `expectedAmount` opcional, `currency`, `frequency` (`monthly`, `bimonthly`, `quarterly`, `semiannual`, `annual`), `dueDay` (1 a 31), `reminderDaysBefore` (0 a 60), `startsOn` y `status` inicial (`active` o `paused`).
- **`propertyId` opcional:** el inmueble debe existir, **pertenecer al usuario** y estar activo. Uno ajeno responde 404, igual que uno inexistente. La base de datos lo refuerza con la FK compuesta `(property_id, owner_id)`.
- **Edición de la definición:** **no** modifica los períodos ya registrados. Cada período guarda su propio monto y moneda.
- **Lo que un PATCH no puede hacer:** cambiar el propietario ni la moneda, ni tocar períodos o confirmaciones.
- **Estados:** `active` ↔ `paused`. `archived` es final: una obligación archivada no admite más cambios ni nuevos períodos (409), pero conserva su historial.

### Períodos
- **Creación:** siempre en `pending`. El monto se toma del cuerpo o, si se omite, se copia el `expectedAmount` vigente de la obligación. La moneda se copia de la obligación.
- **Fechas:** `periodEnd` debe ser mayor o igual que `periodStart` (400). No se permite repetir `periodStart` dentro de la misma obligación (409, restricción `UNIQUE`).
- **Edición (PATCH):** solo en `pending` u `overdue`, sobre `periodStart`, `periodEnd`, `dueDate` y `amount`. `status` solo admite `cancelled`, que anula el período sin borrarlo.
- **Inmutabilidad:** los períodos `paid`, `attended` y `cancelled` no se pueden editar (409).
- **Sin automatismos:** el estado `overdue` lo asignarán en el futuro reglas determinísticas o n8n. Esta API **nunca** cambia un estado por el paso del tiempo y no genera períodos automáticamente.

### Confirmación manual
`POST …/confirm` con `{"result":"paid"|"attended","reference?":"…"}` registra que **el usuario declara** haber pagado o atendido la obligación. NotiHouse-Pal no ejecuta pagos, no consulta bancos y no procesa comprobantes.

1. La obligación y el período deben pertenecer al usuario; si no, 404.
2. Solo se confirma desde `pending` u `overdue`.
3. El servidor asigna `confirmedBy` (perfil del JWT) y `confirmedAt` (reloj de PostgreSQL, `now()`). El cliente no puede enviarlos.
4. El cambio de estado y el evento de auditoría se escriben en **la misma transacción**. El evento lleva `humanConfirmation: true`.

| Situación | Respuesta |
|---|---|
| Primera confirmación | 200 con el período confirmado |
| Repetir **el mismo** resultado y **la misma** referencia (doble clic) | 200 con el período tal como estaba: mismo `confirmedAt` y **sin** nuevo evento de auditoría. La referencia se compara tras recortar espacios; omitirla equivale a no tener referencia |
| Repetir con **otra** referencia, añadirla u omitir la registrada | 409: la confirmación original no se sobrescribe (igual que la evidencia de los cobros) |
| Resultado **distinto** de uno ya confirmado | 409 |
| Período anulado (`cancelled`) | 409 |

**Concurrencia:**
- La transacción toma el período con `SELECT … FOR UPDATE` y actualiza con la condición `status IN ('pending','overdue')`. De dos solicitudes simultáneas, la segunda espera al bloqueo y ve el estado ya confirmado, así que solo una transición prevalece.
- Las pruebas lo verifican con solicitudes simultáneas sobre PGlite. PGlite serializa las transacciones, por lo que el bloqueo real entre conexiones de PostgreSQL no se ejercita en las pruebas automáticas.

## 5. Aislamiento por propietario

- El propietario sale **solo** del JWT validado (`@CurrentUser()` → `user.profileId`). Nunca del cuerpo, la consulta ni la URL.
- Cada consulta de los servicios incluye `owner_id = user.profileId`. Los períodos además exigen `obligation_id` igual al de la ruta, así que un período de otra obligación responde 404 aunque sea del mismo usuario.
- Un recurso ajeno es indistinguible de uno inexistente: 404, sin datos en la respuesta.
- La base de datos refuerza el aislamiento con FKs compuestas `(…, owner_id)`, pero la autorización vive en la capa de servicios.

## 6. Auditoría transaccional

Cada escritura inserta un evento en `audit_events` (append-only, protegido por trigger) **dentro de la misma transacción** que el cambio de negocio. Si la auditoría falla, la transacción completa se revierte y la API responde 500 sin dejar cambios. Las pruebas lo verifican forzando el fallo.

| Acción | Cuándo |
|---|---|
| `property.create` / `property.update` | Crear o editar un inmueble |
| `obligation.create` / `obligation.update` | Crear o editar una obligación |
| `obligation_occurrence.create` / `obligation_occurrence.update` | Crear, editar o anular un período |
| `obligation_occurrence.confirm` | Confirmación humana |

Campos registrados:
- `actor_type = 'user'`, con `actor_id` y `owner_id` iguales al perfil autenticado.
- `component` (`api.properties`, `api.obligations`, `api.obligation-occurrences`).
- `result = 'success'` y `occurred_at` asignado por el servidor.
- `correlation_id`: se toma de la cabecera `X-Correlation-Id` si es un UUID; si no, se genera uno. En ambos casos se devuelve en la misma cabecera de la respuesta.
- `metadata` mínima: `resource`, `resourceId`, nombres de los campos modificados y transición de estado. Nunca tokens, contraseñas ni valores sensibles.

Un PATCH que no cambia ningún valor no escribe ni audita.

## 7. Códigos de respuesta

| Situación | HTTP |
|---|---|
| Creación correcta | 201 |
| Consulta, actualización o confirmación correcta | 200 |
| Datos inválidos, UUID mal formado, PATCH vacío, propiedades no permitidas | 400 |
| Sin token o token inválido | 401 |
| Recurso inexistente o de otro propietario | 404 |
| Período duplicado, inmueble con nombre repetido, obligación archivada, inmueble no activo, período confirmado o anulado, confirmación contradictoria | 409 |
| PostgreSQL no disponible | 503 |

Un filtro global (`DatabaseExceptionFilter`) traduce los errores conocidos de PostgreSQL (violaciones de unicidad, checks, FKs, formato y conexión) a 400, 409 o 503 con mensajes genéricos. Nunca expone SQL, nombres internos ni credenciales. El resto conserva el 500 genérico de Nest.

## 8. Pruebas

| Archivo | Cobertura |
|---|---|
| `test/properties.e2e-spec.ts` | JWT obligatorio; creación y auditoría con `correlation_id`; validaciones; nombre duplicado (409); listados aislados; paginación y filtros; 404 ajeno o inexistente; edición y desactivación; intentos de cambiar el propietario; ausencia de DELETE |
| `test/obligations.e2e-spec.ts` | Obligaciones (sin inmueble, con inmueble propio, ajeno → 404, inactivo → 409, 12 entradas inválidas, filtros, aislamiento, la edición no altera los períodos, campos prohibidos, archivado final); períodos (copia de monto y moneda, montos exactos, duplicados, fechas, orden, pares obligación/período incorrectos, edición e inmutabilidad, sin confirmación automática); confirmación (servidor asigna `confirmedBy`/`confirmedAt`, campos del cliente rechazados, otro usuario → 404, idempotencia, 409, concurrencia contradictoria e idéntica); auditoría (rollback forzado en creación, edición y confirmación; eventos inmutables) |
| `test/auth.e2e-spec.ts` | Además verifica que **todas** las operaciones de Swagger, salvo `/health` y `/auth/login`, exigen Bearer |
| `src/common/*.spec.ts` | Validadores de fecha y dinero; traducción de errores de PostgreSQL |

Las pruebas usan PostgreSQL en memoria (PGlite) con las migraciones versionadas. No escriben en Neon.

## 9. Limitaciones del MVP

- Sin borrado físico (decisión de diseño). Sin generación automática de períodos ni cálculo automático de `overdue`.
- `providerId` (catálogo de proveedores y enlaces oficiales de pago) no se expone todavía: el catálogo está vacío y su administración no forma parte de esta fase.
- La concurrencia real entre conexiones solo se garantiza por diseño (`FOR UPDATE` más actualización condicional). Las pruebas automáticas la ejercitan sobre PGlite, que serializa las transacciones.
- La API sigue conectándose como `neondb_owner`. Antes del despliegue público hay que crear un rol con privilegios limitados y evaluar RLS (ver [autenticación](../architecture/authentication.md#10-limitaciones-y-requisitos-antes-del-despliegue-público)).

## 10. Arriendos, cobros y contratos (Fase 4.2B)

Reutiliza la misma arquitectura: el propietario sale del JWT, la paginación y los validadores son compartidos, cada escritura se audita en la misma transacción y no hay rutas `DELETE`.

### 10.1 Endpoints

| Método | Ruta | Función | Éxito |
|---|---|---|---|
| GET | `/rentals` | Listar arriendos propios (filtros `propertyId`, `status`) | 200 |
| GET | `/rentals/:id` | Consultar un arriendo propio | 200 |
| POST | `/rentals` | Registrar un arriendo sobre un inmueble propio y activo | 201 |
| PATCH | `/rentals/:id` | Editar el arriendo (no toca cobros ni contratos) | 200 |
| GET | `/rentals/:id/charges` | Listar cobros por fecha esperada (filtros `status`, `periodFrom`, `periodTo`) | 200 |
| GET | `/rentals/:id/charges/:chargeId` | Consultar un cobro | 200 |
| POST | `/rentals/:id/charges` | Crear un cobro (siempre `expected`) | 201 |
| PATCH | `/rentals/:id/charges/:chargeId` | Editar un cobro abierto, o anularlo | 200 |
| POST | `/rentals/:id/charges/:chargeId/confirm` | **Confirmación humana** de recepción | 200 |
| GET | `/contracts` | Listar contratos por vencimiento (filtros `propertyId`, `rentalId`, `status`, `endsFrom`, `endsTo`) | 200 |
| GET | `/contracts/:id` | Consultar un contrato propio | 200 |
| POST | `/contracts` | Registrar metadatos de un contrato (siempre `active`) | 201 |
| PATCH | `/contracts/:id` | Corregir metadatos de un contrato activo | 200 |

| Recurso | Orden estable |
|---|---|
| Arriendos | `created_at`, `id` |
| Cobros | `due_date`, `period_start`, `id` |
| Contratos | `ends_on`, `id` |

`periodFrom`/`periodTo` filtran por `period_start`; `endsFrom`/`endsTo` filtran por `ends_on`. Ambos rangos son inclusivos.

### 10.2 Arriendos

- **Campos:** `propertyId`, `tenantAlias` (opcional, un alias para no guardar datos personales), `expectedAmount` (canon, decimal como texto **mayor que cero**), `currency` (por defecto `COP`), `dueDay` (1 a 31), `startsOn`, `endsOn` (opcional) y `status` inicial (`active` o `suspended`).
- **Inmueble:** debe ser propio (si no, 404) y estar `active` (si no, 409). La FK compuesta `(property_id, owner_id)` lo refuerza.
- **Solapamiento (Fase 4.2F.2):** para el MVP cada inmueble es una unidad arrendable. Crear o editar un arriendo responde **409** si queda `active` o `suspended` y comparte algún día con otro `active` o `suspended` del mismo inmueble. `endsOn` nulo significa sin fin; los intervalos consecutivos están permitidos y `ended` no ocupa el inmueble. La regla está en el servicio, con el inmueble bloqueado (`FOR NO KEY UPDATE`) para evitar carreras; no hay restricción de esquema.
- **PATCH:** edita `tenantAlias`, `expectedAmount`, `dueDay`, `startsOn`, `endsOn` y `status`.
  - No se pueden cambiar `propertyId` ni `currency`: de ellos dependen los cobros y los contratos (FK `contracts_rental_property_owner_fk`). Para corregir un inmueble mal asociado se termina el arriendo y se registra otro.
  - Cambiar el canon **no** altera los cobros registrados: cada cobro guarda su monto.
- **Estados:** `active` ↔ `suspended`, y cualquiera de los dos → `ended`. `ended` es final: un arriendo terminado no admite cambios ni cobros nuevos (409), pero sus cobros existentes se pueden seguir confirmando o anulando.

### 10.3 Cobros

- **Creación:** siempre en `expected`. El monto se toma del cuerpo o se copia del canon vigente; la moneda siempre se copia del arriendo.
- **Validaciones:**
  - `periodEnd >= periodStart`.
  - `periodStart` debe caer dentro de la vigencia del arriendo, entre `startsOn` y `endsOn` (400).
  - No puede repetirse `periodStart` en el mismo arriendo (409, restricción `rent_charges_period_unique`).
- **PATCH:** solo en `expected`, `pending` u `overdue`, sobre `periodStart`, `periodEnd`, `dueDate` y `expectedAmount`. `status` solo admite `cancelled`.
- **Campos prohibidos en PATCH:** `received`, `confirmedAt`, `confirmedBy`, `confirmationEvidence`, `rentalId`, `ownerId` y `currency`. El `ValidationPipe` los rechaza con 400.
- **Inmutabilidad:** un cobro `received` o `cancelled` no se edita (409).
- **Sin automatismos:** la API nunca cambia un cobro a `pending`, `overdue` ni `received` por fecha. Esos estados quedan para las reglas determinísticas futuras y para la confirmación humana.

### 10.4 Confirmación manual de recepción

`POST /rentals/:id/charges/:chargeId/confirm` con `{"evidence":"…"}` registra que **el propietario declara** haber recibido el cobro. NotiHouse-Pal no consulta bancos ni verifica transferencias.

- `evidence` es **obligatoria**: entre 1 y 500 caracteres, sin contar los espacios iniciales y finales. Es la referencia de transferencia o la nota del propietario que exige el check `rent_charges_confirmation`. No se suben archivos.
- El servidor asigna `confirmedBy` (perfil del JWT) y `confirmedAt` (`now()` de PostgreSQL). Si el cliente los envía, la respuesta es 400.
- El cobro debe pertenecer al propietario **y** al arriendo de la URL. Si no, 404.

| Situación | Respuesta |
|---|---|
| Primera confirmación | 200, `status: received` |
| Repetir con **la misma** evidencia (doble clic) | 200 sin cambios: mismo `confirmedAt` y **sin** nuevo evento de auditoría |
| Repetir con **otra** evidencia | 409: la declaración original no se sobrescribe |
| Cobro anulado | 409 |

**Concurrencia:** se usa `SELECT … FOR UPDATE` sobre el cobro y un `UPDATE … WHERE status IN ('expected','pending','overdue')`. Si no se actualiza ninguna fila, la respuesta es 409, igual que en la confirmación de obligaciones.

La auditoría registra `humanConfirmation: true` y `hasEvidence: true`, **no** el texto de la evidencia, que queda en el propio cobro.

### 10.5 Contratos

- **Creación:**
  - El inmueble debe ser propio (404) y estar activo (409).
  - `rentalId` es opcional. Si se envía, debe ser propio (404) y del **mismo inmueble** (400). La FK `contracts_rental_property_owner_fk` lo refuerza.
  - `documentId` es opcional. Si se envía, debe ser un documento propio ya registrado (404) de tipo `contract` (400). No hay carga ni generación de archivos.
- **`endsOn` es obligatoria:** sin ella la respuesta es 400 con el mensaje "endsOn es obligatoria: registra el contrato cuando conozcas su fecha de finalización". Nunca se inventa una fecha. Además, `endsOn >= startsOn`.
- **PATCH (corrección manual):** edita `startsOn`, `endsOn`, `noticePeriodDays` (0 a 365 o `null`), `documentId` (o `null`) y `status`.
  - Cambiar fechas actualiza el **mismo** contrato: no crea uno nuevo ni lo "renueva".
  - La auditoría guarda `dateChanges` con el valor anterior y el nuevo.
- **Asociaciones:** `propertyId` y `rentalId` **no** se pueden cambiar (400). Es la política más conservadora: si la asociación es incorrecta, se termina el contrato y se registra otro.
- **Estados:** `active` → `expired` o `terminated`, solo por una edición explícita. Un contrato vencido o terminado ya no admite cambios (409).
- **Sin automatismos:** ninguna consulta, arranque ni cron marca contratos como vencidos, y no hay renovación, extensión, firma ni generación de documentos. Terminar un arriendo **no** modifica su contrato.

### 10.6 Auditoría

| Acción | Componente |
|---|---|
| `rental.create` / `rental.update` | `api.rentals` |
| `rent_charge.create` / `rent_charge.update` / `rent_charge.confirm` | `api.rent-charges` |
| `contract.create` / `contract.update` | `api.contracts` |

Se registran los mismos campos que en la sección 6 (actor, propietario, `correlation_id`, resultado y metadatos mínimos). Si la auditoría falla, la escritura se revierte.

### 10.7 Pruebas

| Archivo | Cobertura |
|---|---|
| `test/rentals.e2e-spec.ts` (86) | 401 sin JWT o con JWT inválido en las 8 rutas; sin DELETE; creación con auditoría y `correlation_id`; inmueble ajeno, inexistente o inactivo; 17 entradas inválidas; aislamiento; paginación y filtros; edición; 7 PATCH prohibidos; el canon no altera los cobros; transiciones de estado; cobros (copia de monto, duplicado 409, 11 entradas inválidas, vigencia, orden y filtros, par arriendo/cobro exacto, anulación e inmutabilidad, sin recepción automática); confirmación (identidad y hora del servidor, evidencia obligatoria, 7 cuerpos inválidos, ajena 404, idempotencia, contradicción 409, anulado 409, concurrencia idéntica y contradictoria); rollback forzado; auditoría append-only |
| `test/contracts.e2e-spec.ts` (35) | 401; creación con o sin arriendo y con documento; `endsOn` obligatoria; fechas contradictorias; inmueble, arriendo o documento ajenos (404); arriendo de otro inmueble (400); inmueble inactivo (409); aislamiento; orden por vencimiento y filtros; sin vencimiento automático; corrección de fechas auditada con valores anterior y nuevo; 7 PATCH prohibidos; estados finales; terminar el arriendo no altera el contrato; rollback forzado |

**Limitación:** PGlite serializa las transacciones. Las pruebas de concurrencia verifican la lógica de estado e idempotencia, pero **no** el bloqueo real entre conexiones independientes de Neon. Esa verificación queda pendiente para la revisión final, con datos ficticios controlados.
