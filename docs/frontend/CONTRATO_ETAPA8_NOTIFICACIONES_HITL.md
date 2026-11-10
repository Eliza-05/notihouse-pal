# Contrato frontend · Etapa 8: notificaciones, HITL y estados

> Para el equipo frontend. Complementa la [guía frontend](GUIA_FRONTEND_NOTIHOUSE_PAL.md), que sigue siendo la referencia general (autenticación, inventario de endpoints, pantallas). Este documento cubre lo que añadió o precisó la Etapa 7 (7-nov-2026): la campana de alertas por *polling*, el estado de funciones limitadas (kill switch), la pantalla de revisión humana y los nuevos códigos de error.
>
> El backend descrito aquí **aún no está desplegado en Render**: llegará con la publicación controlada de la Etapa 7. Hasta entonces, `GET /alerts/summary` y `GET /system/status` responden 404 en Render. El resto de rutas ya existía.

## 1. Decisión: alertas internas persistentes, sin push

Para el MVP **no hay Firebase Cloud Messaging, WebSockets ni notificaciones push**. Las alertas viven en PostgreSQL y el frontend las consulta. Si el usuario cierra la aplicación, sus alertas siguen guardadas; las que se generen mientras está desconectado también, siempre que el scheduler (n8n) esté encendido. Al volver, las ve.

El valor del MVP es centralizar y anticipar, no la inmediatez. No prometan un tiempo máximo de aviso en la interfaz.

## 2. Campana de alertas

### 2.1 Endpoints (JWT de usuario)

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/api/v1/alerts/summary` | **Contador de la campana** (consulta ligera para *polling*) |
| GET | `/api/v1/alerts?state=active&pageSize=20` | Lista de la campana (más recientes primero) |
| GET | `/api/v1/alerts?state=resolved` · `?state=dismissed` | Historial |
| GET | `/api/v1/alerts/:id` | Detalle |
| POST | `/api/v1/alerts/:id/read` | Marcar como leída (idempotente) |
| POST | `/api/v1/alerts/:id/dismiss` | Descartar (idempotente; 409 si ya está resuelta) |

Otros filtros de la lista: `read=true|false`, `type`, `severity`, `requiresAttention=true|false`, `order=asc|desc`, `page`, `pageSize`.

Respuesta de `GET /alerts/summary`:

```json
{
  "active": 3,
  "unread": 2,
  "criticalUnread": 1,
  "latestCreatedAt": "2026-11-07T18:40:12.000Z",
  "serverTime": "2026-11-07T19:02:00.000Z"
}
```

- `unread` es el número de la campana: alertas **vigentes** sin leer.
- Si `latestCreatedAt` cambia respecto a la consulta anterior, hay alertas nuevas: pidan la lista.
- La consulta no modifica nada ni genera auditoría. Responde 401 sin sesión.

Cada alerta de la lista trae: `id`, `type`, `severity` (`info` | `warning` | `critical`), `title`, `message`, `relevantDate`, `state` (`active` | `dismissed` | `resolved`), `requiresAttention`, `read`, `readAt`, `createdAt`, y `resource { type, id, path }` para navegar al recurso.

### 2.2 Tipos de alerta

| `type` | Severidad | Recurso | Texto sugerido de acción |
|---|---|---|---|
| `obligation_due_soon` | warning | período de obligación | "Ver obligación" |
| `obligation_overdue` | critical | período de obligación | "Ver obligación" |
| `rent_charge_due_soon` | warning | cobro de arriendo | "Ver cobro" |
| `rent_charge_overdue` | critical | cobro de arriendo | "Ver cobro" |
| `contract_ending_soon` | warning | contrato | "Ver contrato" |
| `contract_end_passed` | critical | contrato | "Ver contrato" |
| `hitl_pending` | warning | revisión humana | "Revisar" |
| `hitl_due_soon` | critical | revisión humana | "Revisar ahora" |
| `hitl_overdue` | critical | revisión humana | "Ver revisión vencida" |

Una revisión humana pendiente aparece **una sola vez** en alertas (escala `pending` → `due_soon` → `overdue` sin duplicarse) y también en la bandeja de atención (`GET /attention`). No muestren ambos como dos avisos emergentes distintos: la alerta lleva a la misma revisión.

### 2.3 Polling: comportamiento obligatorio

Intervalo inicial: **60 segundos**, configurable (por ejemplo `VITE_ALERTS_POLL_MS=60000`). Valores razonables: 30 s a 120 s.

1. **Al iniciar sesión**: consultar `GET /alerts/summary` de inmediato.
2. **Mientras la pestaña esté visible**: repetir cada `VITE_ALERTS_POLL_MS`.
3. **Pestaña oculta** (`document.visibilityState === 'hidden'`): pausar.
4. **Al recuperar el foco o volver a visible**: consultar de inmediato y reanudar el intervalo.
5. **Sin solicitudes duplicadas**: si hay una consulta en curso, no lanzar otra. Usen `AbortController` al desmontar.
6. **Al cerrar sesión**: detener el intervalo, abortar la consulta en curso y borrar contadores, listas y cachés (incluida la de React Query, SWR o similar).
7. **Al cambiar de usuario**: igual que al cerrar sesión, antes de la primera consulta del nuevo usuario. El backend responde `Cache-Control: no-store`: no hay caché HTTP entre cuentas, pero la caché de la aplicación sí debe limpiarse.
8. **Aviso emergente (toast) solo una vez por alerta**: guarden los `id` ya notificados (en memoria o en `sessionStorage`, por usuario) y muestren el toast solo para `id` nuevos. Al abrir la campana, marcar como leída la alerta que el usuario abre (`POST /alerts/:id/read`), no todas.
9. **Errores**: 401 → la sesión expiró (JWT de 30 min, sin refresh): redirigir al login. 503 o error de red → mantener el último contador y mostrar un indicador discreto; reintentar en el siguiente ciclo, sin bucles. Render Free puede tardar cerca de un minuto en despertar.

Pseudocódigo orientativo:

```ts
const POLL_MS = Number(import.meta.env.VITE_ALERTS_POLL_MS ?? 60000);
let timer: number | undefined;
let inFlight: AbortController | null = null;

async function poll() {
  if (inFlight || document.visibilityState !== 'visible') return;
  inFlight = new AbortController();
  try {
    const s = await api.get('/alerts/summary', { signal: inFlight.signal });
    store.setSummary(s); // si s.latestCreatedAt cambió → refrescar la lista
  } catch (e) {
    if (isUnauthorized(e)) return logout();
    store.markStale();
  } finally {
    inFlight = null;
  }
}
export function startAlertsPolling() {
  poll();
  timer = window.setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('focus', poll);
}
export function stopAlertsPolling() {
  window.clearInterval(timer);
  inFlight?.abort();
  document.removeEventListener('visibilitychange', poll);
  window.removeEventListener('focus', poll);
  store.clearAlerts();
}
```

### 2.4 Tiempos: qué se puede prometer

| Tramo | Quién lo controla | Valor de diseño |
|---|---|---|
| A. La condición ocurre → el motor la evalúa | Scheduler n8n (workflow 06), cada hora mientras n8n esté encendido | ≤ 1 h con n8n encendido. **Sin n8n no hay evaluación**: al volver, una evaluación recupera el estado actual |
| B. Evaluación → alerta guardada | Backend | Milisegundos (medido en pruebas) |
| C. Alerta guardada → visible en la campana | Frontend | ≤ intervalo de polling (60 s) con la pestaña visible |

Una obligación confirmada como pagada deja de contar **de inmediato** en el contador (el cálculo es en vivo), aunque la evaluación aún no haya corrido.

## 3. Funciones temporalmente limitadas (kill switch)

`GET /api/v1/system/status` (JWT):

```json
{
  "limited": true,
  "limitedFunctions": [
    { "scope": "document_processing", "label": "Interpretación automática de documentos PDF", "since": "2026-11-07T18:00:00.000Z" }
  ],
  "serverTime": "2026-11-07T19:00:00.000Z"
}
```

- Consúltenlo al iniciar sesión y junto con el resumen de alertas (o cada 5 minutos).
- Si `limited` es `true`, muestren un aviso no bloqueante con las `label`. Ejemplo: "Algunas funciones automáticas están temporalmente limitadas: Interpretación automática de documentos PDF. Tus datos siguen disponibles".
- Las lecturas y las acciones manuales siguen funcionando: registrar, confirmar pagos y decidir revisiones.
- Cualquier escritura afectada responde **503** con `code: "KILL_SWITCH_ACTIVE"` y `scope`. Muestren el mensaje del backend y no reintenten en bucle.

| `scope` | Qué se detiene |
|---|---|
| `global` | Todas las automatizaciones y la aplicación de propuestas |
| `gmail_ingestion` | Recepción de facturas desde Gmail |
| `document_processing` | Interpretación de PDF |
| `voice_processing` | Interpretación de notas de voz |
| `case_processing` | Procesamiento automático de casos |
| `hitl_closure` | Cierre automático de casos revisados |
| `hitl_expiry` | Vencimiento automático de revisiones |
| `alert_evaluation` | Generación automática de alertas |
| `proposal_application` | `POST /cases/:caseId/proposals/:proposalId/apply` |

Las cargas de archivos se siguen aceptando: quedan en cola y se procesan cuando se reanude.

## 4. Pantalla de revisión humana (HITL real, no decorativo)

`GET /api/v1/hitl-requests/:id` devuelve la revisión con su propuesta. La pantalla **debe** mostrar:

| Elemento | De dónde sale |
|---|---|
| Documento o audio fuente | `proposal.documentId` → `GET /documents/:id/content` (descarga autenticada; no hay URL pública) |
| Datos propuestos | `proposal.proposedData` (si es aplicable: `{ action, data }`) |
| Valor original y fragmentos de evidencia | `proposal.evidence.fragments[] { field, text }` |
| Alternativas | `options.choices[] { key, label }` (p. ej. dos montos posibles) |
| Inconsistencias y advertencias | `proposal.proposedData.camposProblematicos[]`, `proposal.evidence.advertencias[]`, `options.context.advertencias[]` |
| Alerta de seguridad | `proposal.proposedData.alertaSeguridad` (documento con instrucciones dirigidas al sistema; **se ignoraron**) |
| Posible duplicado | `options.context.documentoDuplicado` (id del documento idéntico ya cargado) |
| Consecuencias | `options.context.consecuencias` (texto listo para mostrar) |
| Fecha límite | `dueAt`; `overdue` indica si ya venció |
| Opciones de decisión | Aprobar / Rechazar (con `choice` si hay alternativas) y comentario opcional |

Reglas de interacción:

- **Aprobar no aplica.** Para una propuesta aplicable (`decisionType = data_confirmation`, sin `choices`), tras aprobar, ofrezcan un botón explícito "Aplicar" → `POST /cases/:caseId/proposals/:proposalId/apply`. Aplicar crea un período **pendiente**: nunca registra pagos.
- Con `choices` (por ejemplo `conflict_resolution` por dos montos) **no hay aplicación automática**. La persona elige y luego registra o corrige manualmente en el formulario de obligaciones.
- Revisión vencida (`status = expired`): mostrar "Venció sin decisión; no se aplicó nada". No ofrecer botones de decisión. El caso queda detenido; si hace falta, el usuario vuelve a cargar el documento.
- **Silencio ≠ aprobación**: nunca preseleccionen "Aprobar" ni lo hagan por omisión.

## 5. Nuevos códigos de error

| HTTP | `code` | Cuándo | Qué mostrar |
|---|---|---|---|
| 503 | `KILL_SWITCH_ACTIVE` | La función está detenida por el kill switch | El `message` del backend; sin reintento automático |
| 409 | `CONTRADICTING_SOURCE` | Al aplicar: otra fuente (voz, Gmail, carga) describe la misma obligación con monto o fecha distintos | Las dos versiones (`proposed` y `conflicts[] { caseId, source, amount, dueDate }`) y un enlace a la otra revisión para rechazar la incorrecta |
| 409 | — | Al aplicar: obligación o período duplicados (posible duplicado E3/E7) | "Ya existe; revisa si es la misma factura o regístrala sobre la obligación correcta" |
| 409 | — | Decidir una revisión vencida, anulada o ya decidida de otra forma | Recargar la revisión y mostrar su estado |

## 6. Aislamiento entre usuarios

Todo dato sale del JWT: el frontend nunca envía `ownerId`. Un recurso de otra cuenta responde 404 (no 403). Al cerrar sesión o cambiar de cuenta, limpien **todo** el estado de la aplicación antes de pedir datos del nuevo usuario.
