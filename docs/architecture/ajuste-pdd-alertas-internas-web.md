# Registro de ajuste al PDD/SDD: alertas internas web en lugar de FCM (MVP)

| Campo | Valor |
|---|---|
| Fecha de la decisión | 7 de noviembre de 2026 (Etapa 7) |
| Decidido por | Equipo del proyecto (responsable del backend), por instrucción expresa |
| Documentos afectados | PDD A3 paso 4, A6 (fila "Notificaciones push al usuario mediante FCM"), A7 nota de SLA; SDD B2 (herramienta FCM), B3 (canal "HITL + FCM"), 4.1 (actividad de notificación), 4.2 (reintento de FCM) |
| Estado de FCM | **Pospuesto** para una versión posterior. **No está implementado** |

## Qué cambia

El PDD/SDD define Firebase Cloud Messaging como canal de notificación push. Para el MVP académico, las alertas se entregan como **alertas internas web persistentes**:

1. El motor de reglas (backend) evalúa las condiciones y **crea, escala o resuelve** alertas en PostgreSQL (Neon), asociadas solo al usuario propietario.
2. El frontend las consulta por API autenticada (`GET /alerts/summary` y `GET /alerts`) con *polling* cada 60 s, configurable, mientras el dashboard está visible.
3. Si el usuario no está conectado, las alertas quedan guardadas y las ve al volver. No hay notificación al dispositivo.

## Qué no cambia

- Las reglas de negocio R4, R7 y R10: la condición que dispara una alerta sigue siendo determinística y ajena al agente.
- La arquitectura de alertas del backend: tabla `alerts`, deduplicación `tipo:recurso:fecha`, una alerta activa por recurso, resolución automática.
- El agente no decide cuándo se genera una alerta.
- Ninguna alerta modifica pagos, cobros, contratos ni revisiones.

## Efecto en los SLA

El SLA "solicitud a FCM en máximo 5 minutos" se sustituye por tres tramos medibles por separado:

| Tramo | SLA de diseño en el MVP |
|---|---|
| A. Condición → evaluación | ≤ 1 h con el scheduler (n8n, workflow 06) encendido. Con n8n apagado no hay evaluación; al volver, una evaluación recupera el estado actual |
| B. Evaluación → alerta persistida | ≤ 5 min (medido: milisegundos) |
| C. Persistencia → visible en la interfaz | ≤ intervalo de polling (60 s) con la pestaña visible |

El reintento de "Envío de notificación a FCM" (SDD 4.2) no aplica: la alerta ya está guardada. Si el frontend no puede consultar, reintenta en el siguiente ciclo sin perder nada.

## Riesgo aceptado

El usuario puede conocer tarde un evento si no abre la aplicación. Es aceptable para el MVP porque su valor es centralizar, anticipar vencimientos y conservar el historial, no la inmediatez. El riesgo ya figuraba en el PDD ("la entrega final también depende de FCM, conectividad y disponibilidad del dispositivo").

## Para reintroducir FCM más adelante

Añadir un consumidor de alertas recién creadas (estado `active`, sin `delivered_at`) que invoque FCM con un reintento, según el SDD 4.2, sin cambiar el motor de reglas. Requeriría una columna de entrega, es decir, una migración.
