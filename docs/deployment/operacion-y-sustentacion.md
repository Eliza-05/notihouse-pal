# Operación local y guion de sustentación (Etapa 7 → Etapa 8)

> Para quien opera la demostración (responsable del backend y n8n). Ningún paso imprime secretos. Las acciones marcadas con ⚠ escriben en servicios compartidos (Neon, Render, Gmail o la cuota de Gemini) y requieren autorización expresa.

## 1. Encender la infraestructura

| Paso | Comando o acción | Comprobación |
|---|---|---|
| Docker Desktop | Abrirlo y esperar a "Engine running" | `docker ps` responde |
| n8n de NotiHouse-Pal | `docker compose -f infra/n8n/docker-compose.yml up -d` (volumen `notihouse_n8n_data`; **nunca** montar `n8n_data`, que es de otro proyecto) | `docker ps` muestra `notihouse-n8n` |
| Despertar Render Free | Abrir `https://notihouse-pal-api.onrender.com/api/v1/health` y esperar hasta 1 min | `200 {"status":"ok"}` |
| Comprobar Neon | `https://notihouse-pal-api.onrender.com/api/v1/health/ready` | `200`. Un `503` suele indicar que Neon despierta: reintentar a los pocos segundos |
| Prueba de conexión n8n ↔ API | Workflow 01 (manual) | Todas las comprobaciones en verde |

## 2. Comprobaciones previas a la demostración

| Qué | Cómo | Resultado esperado |
|---|---|---|
| Gmail OAuth | En n8n, credencial `NotiHouse Gmail` → "Test" (solo lectura). En modo Testing el refresh token **vence a los 7 días**: si falla, reconectar | Conexión correcta |
| Gemini (⚠ consume 1 petición de 20/día) | Ejecutar a mano el workflow 02 **con `AUTORIZAR_RECLAMACION = false`**: solo hace el sondeo sintético | "preflight: correcto". Un 429 significa cuota agotada: no insistir, se renueva hacia las 08:00 UTC |
| Cola de trabajos | Lectura con el token de servicio: `POST /internal/workflow-jobs/claim` **no** (reclama). Usar la consulta de solo lectura del responsable o los casos de la cuenta (`GET /cases?status=processing`) | Sin trabajos atascados |
| Kill switch | `cd backend && npm run ops:kill-switch -- status` (solo lectura, requiere `DATABASE_URL_DIRECT`) o `GET /system/status` con un JWT | Ningún alcance activo |
| Alertas | `GET /alerts/summary` con la cuenta demo | Contador coherente |

## 3. Guion de demostración

### 3.1 Flujo positivo (PDF → propuesta → HITL → aplicar)

1. ⚠ Subir un PDF ficticio nuevo desde el frontend (`POST /ingestions/documents`). **No reutilizar** `factura-ficticia-positiva.pdf` con Daniel: ya existe y la aplicación respondería 409 por duplicado (lo cual también se puede mostrar como E3).
2. ⚠ Ejecutar el workflow 02 a mano con `AUTORIZAR_RECLAMACION = true` (importar una copia y restaurar en `finally`, como en la Etapa 6). Si la automatización programada está autorizada, basta esperar el siguiente ciclo de 5 minutos.
3. Mostrar la revisión: fuente, evidencia, consecuencias y plazo de 24 h.
4. ⚠ Aprobar y luego **aplicar** de forma explícita: se crea un período `pending`, nunca un pago.
5. El workflow 03 cierra el caso.

### 3.2 Abstención (sin tocar datos compartidos)

Ejecutar `node n8n/tests/agent-eval.test.mjs`: 50 escenarios con el código real de los workflows y sin llamar a Gemini. Mostrar E1 (dos montos → alternativas, ninguno elegido), E6 ("el viernes" → no se programa), E13 (inyección → alerta de seguridad) y la matriz de abstención (0 inventados, 0 parálisis). Opcional: `EVAL_WORKFLOW_DIR=<carpeta con la versión anterior>` para mostrar los 16 inventos de la versión anterior.

### 3.3 HITL y caducidad

- Revisión pendiente: la de Daniel de la Etapa 6 (`d6d63e6a…`) está **sin decidir a propósito**. Si se aprueba y aplica, la aplicación responderá 409 porque la obligación ya existe desde la Etapa 4. Es una demostración válida de E3; no se crea nada.
- Caducidad: mostrar `npx vitest run --config ./vitest.config.e2e.ts test/hitl-sla.e2e-spec.ts` (antes, exactamente en y después del límite, con reloj controlado y sin tocar datos reales).

### 3.4 Kill switch sin afectar datos compartidos

Usar el laboratorio, no Neon: `node n8n/tests/scheduled-stack.test.mjs` (≈5 min). Levanta PostgreSQL, el backend y n8n desechables con los workflows **activos**. Muestra que los disparadores procesan solos, que el kill switch los detiene, que el usuario ve "función limitada" y que la reanudación controlada los reactiva, todo auditado. Alternativa rápida: `test/kill-switch.e2e-spec.ts`.

> Activar el kill switch en Neon para la demostración es posible (`activate` y luego `resume`) y no borra datos, pero deja eventos permanentes en la auditoría compartida. Hacerlo solo con autorización.

### 3.5 Recuperación de una falla

- **n8n apagado:** los trabajos quedan `pending` con 0 intentos; al encender n8n, el siguiente ciclo los procesa (probado en `scheduled-stack`).
- **Cuota de Gemini (429):** el trabajo vuelve a `pending` con espera exponencial, y la ruta programada se pausa hasta la renovación diaria (o el `retryDelay` indicado) sin consumir intentos.
- **Render dormido:** los workflows llaman primero a Health y Readiness con reintentos de hasta 90 s.
- **3 fallos críticos seguidos:** kill switch automático del componente; revisar la causa y reanudar con `ops:kill-switch resume` y la evidencia de una prueba.

## 4. Activar la automatización programada en el entorno operativo (⚠ requiere autorización)

Los workflows versionados están **inactivos** y con `AUTOMATIZACION_PROGRAMADA = false`. Para activarlos:

1. Desplegar antes el backend de la Etapa 7 en Render (incluye `GET /alerts/summary`, el kill switch y E12). **No requiere migraciones ni variables nuevas.**
2. Importar con `node n8n/tools/import-workflow.mjs n8n/workflows/0X-….json` (resuelve credenciales por nombre).
3. En la copia importada, poner en `true` `AUTORIZAR_RECLAMACION` (02, 03, 04) o `AUTORIZAR_MANTENIMIENTO` (06), y `AUTOMATIZACION_PROGRAMADA`. En el 05, además los dos interruptores de Gmail, el buzón y los remitentes.
4. Publicar o activar en la interfaz de n8n. Intervalos: 02/03/04 cada 5 min, 05 cada 15 min, 06 cada 15 min (alertas como máximo una vez por hora).
5. **Cuota de Gemini:** la ruta programada **no** hace sondeo; solo llama a Gemini si reclamó un trabajo (1 llamada por PDF, 2–3 por nota de voz). Con 20 peticiones al día, el límite práctico es de unos 6–10 documentos diarios.
6. **Render Free:** con polling cada 5 min el servicio no se duerme. Consume unas 720 h al mes de las 750 h gratuitas, compartidas entre los servicios gratuitos de la cuenta.
7. n8n corre en el equipo local: la automatización solo funciona mientras ese equipo y Docker estén encendidos.

## 5. Ejecutar todas las pruebas

```bash
cd backend
npm run build && npm run lint && npx tsc --noEmit -p tsconfig.json
npm test                 # unitarias (PGlite)
npm run test:e2e         # e2e (PGlite)
# PostgreSQL 18 real y desechable (Docker)
npm run conc:up && npm run conc:init && npm run conc:suite && npm run conc:down
cd ..
node n8n/tests/agent-eval.test.mjs          # evaluación del agente (sin Gemini)
node n8n/tests/gmail-stack.test.mjs         # Gmail con backend real (Docker)
node n8n/tests/voice-stack.test.mjs         # voz con backend real (Docker)
node n8n/tests/scheduled-stack.test.mjs     # disparadores programados reales (Docker)
```

Ninguna de estas pruebas toca Neon, Render, Tigris, Gmail ni el n8n operativo.
