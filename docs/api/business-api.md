# API de negocio: inmuebles, obligaciones y períodos (Fase 4.2A)

API REST para que un usuario autenticado administre sus inmuebles, las definiciones de sus obligaciones recurrentes del hogar, los períodos concretos de cada obligación y la confirmación manual de pago o atención.

> **Alcance:** solo el proceso A (obligaciones del hogar) e inmuebles. Arriendos, cobros, contratos, IA, voz, Gmail, FCM y workflows de n8n **no** están implementados. Tampoco existe generación automática de períodos ni confirmación automática.

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
| Repetir **el mismo** resultado (doble clic) | 200 con el período tal como estaba: mismo `confirmedAt` y **sin** nuevo evento de auditoría |
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
