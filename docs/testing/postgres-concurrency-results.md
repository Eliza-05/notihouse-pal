# Resultados de concurrencia en PostgreSQL 18 real (Fase 4.2F.2)

Registro de qué se comprobó, con qué evidencia y qué sigue sin comprobarse. Ejecución: 2026-11-03, en un equipo local con Docker. Los cambios de esta fase están pendientes de revisión: no hay commit ni despliegue.

## 1. Alcance de cada entorno

| Entorno | Qué se hizo | Qué demuestra |
|---|---|---|
| **PGlite** (`npm run test:e2e`) | 476 pruebas de la API en proceso | Lógica e integridad con **una sola conexión**. No demuestra contención |
| **PostgreSQL 18.6 local** (`npm run conc:test`, `conc:suite`) | 183 pruebas y 10 escenarios × 5 repeticiones | Bloqueos, transacciones y concurrencia con **conexiones independientes** |
| **Neon** | Solo lectura: esquema, migraciones, conteos y resúmenes `md5` | Que el esquema es el mismo y que **no se modificó nada**. Sin pruebas de carga ni de bloqueos |
| **n8n** | No conectado | Un cliente HTTP simula su contrato |
| **Gmail, IA, STT, FCM** | No conectados | Se usaron fixtures fijos; nada se envió a ningún proveedor |

## 2. Preparar y ejecutar el entorno

Requisitos: Docker Desktop con Compose, Node 24 y `npm ci` en `backend/`. Todos los comandos se ejecutan desde `backend/`.

```bash
npm run conc:env      # genera credenciales aleatorias en .local/concurrency.env (ignorado por Git)
npm run conc:up       # PostgreSQL 18 en 127.0.0.1:55432 (espera al health check)
npm run conc:init     # valida el destino, aplica migraciones, crea notihouse_app y deja la marca
npm run conc:test     # 183 pruebas sobre dos instancias Nest con pools propios
npm run conc:suite    # 10 escenarios × 5 sobre dos procesos reales de la API
node --env-file=.local/concurrency.env dist/database/scripts/concurrency/lock-probe.js
```

**Detener sin borrar nada:** `npm run conc:down`.

**Eliminar solo estos recursos:** `npm run conc:destroy`. Borra el contenedor, la red y el volumen `notihouse-concurrency-data` del proyecto Compose `notihouse-concurrency`. No uses `docker system prune`.

**Empezar de cero:** `conc:destroy`, `conc:up` y `conc:init`. El volumen nuevo tiene otro identificador de sistema; `conc:init` actualiza el estado local que usa la barrera.

**Interpretar resultados** (en `backend/.local/concurrency/`, ignorado por Git):

| Archivo | Contenido |
|---|---|
| `evidence.jsonl` | Por cada carrera: sesiones bloqueadas, PID distintos, instancias de API, eventos de espera y estados HTTP |
| `load-metrics.json` | Métricas de la carga controlada |
| `suite-report.json` | Resultado de los dos procesos reales de la API |
| `neon-before.json`, `neon-after.json` | Huellas de solo lectura de Neon |

Para ver los interbloqueos del servidor: `docker logs notihouse-concurrency-postgres 2>&1 | grep "deadlock detected"`.

Una barrera que no reúne las sesiones esperadas **hace fallar la prueba**: una carrera sin contención no cuenta como superada.

## 3. Protección contra conexión accidental

`src/database/scripts/concurrency/target-guard.ts` falla en cerrado y no tiene opción para forzarla.

| Comprobación | Cómo |
|---|---|
| Habilitación explícita | `CONCURRENCY_TEST_ENABLED=disposable-postgres-only` |
| Host local, sin Neon | La URL debe ser `localhost` o `127.0.0.1`, y no puede contener `neon` |
| Puerto y base | `55432` y `notihouse_concurrency`, en la URL **y** en `current_database()` |
| Distinta de las URL de la aplicación | Se rechaza si coincide con `DATABASE_URL` o `DATABASE_URL_DIRECT` |
| PostgreSQL 18 | `server_version_num` consultado en la sesión |
| Sin parámetros de Neon | `neon.tenant_id` y `neon.timeline_id` |
| Usuario esperado | `current_user`: `notihouse_conc_owner` o `notihouse_app` |
| Marca de inicialización | Comentario de la base con un valor aleatorio local |
| Servidor esperado | `system_identifier` de `pg_control_system()`, guardado al inicializar |
| Fuera de entornos remotos | Rechaza `NODE_ENV=production`, `RENDER` y `CI` |

- **Prueba directa:** con la URL real de Neon, `init-disposable-db` respondió `Destino rechazado (no se escribió nada): … parece apuntar a Neon`, sin abrir conexión.
- **Instancias de la suite:** se sustituye `PG_POOL` por un pool ya verificado, de modo que `backend/.env` no puede abrir conexiones.
- **Procesos reales:** arrancan con un entorno explícito desde un directorio sin `.env`.

Se eliminó la confirmación anterior (`CONCURRENCY_ACK` + `CONCURRENCY_DB_HOST`), porque permitía apuntar a Neon si el operador la confirmaba. `lock-probe` ya tampoco admite Neon.

## 4. Entorno comprobado

| Aspecto | Resultado |
|---|---|
| Servidor | PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2), imagen oficial `postgres:18` |
| Publicación | Solo `127.0.0.1:55432`; autenticación SCRAM |
| Datos | `PGDATA=/var/lib/postgresql/18/docker`, volumen montado en `/var/lib/postgresql` |
| Migraciones | 18 tablas y 3 migraciones; los hashes coinciden con los archivos y con Neon |
| Catálogo frente a PGlite 18.6 | **Sin diferencias** en 274 restricciones, 76 índices, 2 triggers y 207 columnas |
| Append-only | `UPDATE`, `DELETE` y `TRUNCATE` rechazados incluso para el propietario |
| Identidad de la API | `notihouse_app` en todas las sesiones |

## 5. Evidencia de concurrencia real

- **Sesiones independientes:** 4 conexiones con PID y `xid` distintos, y 4 transacciones abiertas a la vez según `pg_stat_activity`.
- **Dos niveles de ejecución:**
  - dos instancias Nest con servidor HTTP y `pg.Pool` de 5 conexiones propios, en un mismo proceso Node;
  - dos procesos `dist/main.js` independientes para los 10 escenarios.
- **Barrera determinista:** una conexión de control bloquea la fila, se lanzan las solicitudes, se espera a verlas en cola en `pg_stat_activity` y se libera. No depende de temporizadores; hay límites de tiempo y siempre se libera el bloqueo.
- **Última ejecución limpia:** 40 carreras con barrera, 105 sesiones bloqueadas distintas sumando todas (hasta 8 por carrera), y 32 carreras con sesiones de las dos instancias a la vez. Eventos de espera: `transactionid` y `tuple`.
- **Tras cada archivo:** ninguna sesión de la API queda `idle in transaction`.

## 6. Resultados por escenario

"Barrera" indica las sesiones de PostgreSQL que estuvieron bloqueadas a la vez en esa carrera.

| Escenario | Resultado esperado | Observado | Barrera |
|---|---|---|---|
| **A** Reclamaciones | Un solo titular | B no recibe el trabajo en curso de A (`SKIP LOCKED`); 12 simultáneas → 1 titular; 6 lotes → 24 trabajos distintos | Por caso |
| **A** Exclusiones | No se entregan | Futuros, completados, fallidos, agotados y de casos cerrados excluidos | — |
| **B** Fencing | Antiguo 409, vigente 200 | `409, 200`; prevalece el resultado vigente; 1 evento con el worker nuevo | 2 |
| **B** Vencidos | 409 sin cambios | `heartbeat`, `complete` y `fail` → 409 | — |
| **B** Heartbeats | Sin transición | 200, 200; se renueva; sin eventos | 2 |
| **C** `complete` idéntico | 200, 1 evento | Igual, aunque cambie el orden de las claves | 4 |
| **C** `complete` contradictorio | 409 sin cambios | `200, 409`; valor, tipo, orden de arreglo y claves extra se detectan | 2 |
| **D** Reintentos | Backoff y fin definitivo | Esperas 30, 60, 120 y 240 s; 5 intentos; trabajo y caso `failed` | — |
| **D** `complete` y `fail` | Un estado terminal | `200, 409` en ambos órdenes; 1 evento | 2 |
| **E** Idempotencia de casos | 1 caso, 1 trabajo, 1 evento | 2, 3 y 20 solicitudes → un solo `201`; dos dueños → 2 casos; datos distintos → 409 | Hasta 3 |
| **F** Propuestas | No revive ni duplica | Reenvío antiguo → 200 `superseded`; 5 distintas → versiones 1–5 con una vigente | 4–5 |
| **G** Aprobar y rechazar | Una decisión, otra 409 | `200, 409` en 4 rondas; propuesta coherente; 1 trabajo `hitl.decision` | 2 |
| **G** Vencimiento | Nunca aprueba | Límite exacto → `expired`; barrido y aprobación → `expired`, 1 evento | 3 |
| **H** Aplicación | Exactamente una vez | 2, 3, 8 y 10 → un solo `201`; 1 período `pending`, 1 aplicación, 1 evento | Hasta 8 |
| **I** Obligaciones | Un estado definitivo | Idénticas → 200; `paid` y `attended` → `200, 409`; confirmar y cancelar → `200, 409` | 2–4 |
| **I** Cobros | Evidencia preservada | Evidencia distinta → `200, 409`; `confirmed_at` lo asigna PostgreSQL | 2–4 |
| **J** Alertas | Sin duplicados | 1 activa por recurso con 6 y 20 evaluaciones; 8 barridos sobre 30 alertas sin 409 | Lote serializado |
| **J** Dashboard | Coherente; GET no escribe | Totales coinciden; huella de alertas, auditoría y períodos igual tras 9 GET | — |
| **K** Ingesta | Sin duplicar | Misma clave → `200, 201` y 1 objeto; mismo SHA en 2 dueños → separados; 6 subidas → 2 aceptadas y 4 con 429 | — |
| **K** Fallos | Compensación | Auditoría falla → sin caso ni objeto; compensación falla → `document.orphaned` | — |
| **L** Arriendos | Sin solapes | Ver sección 8 | 4 |
| **M** Aislamiento | Nunca acceso cruzado | 3 rondas mezcladas → 18 ataques por ronda, todos 404; 40 lecturas sin cruces | — |

Para el detalle exacto de cada caso, ver `backend/test/pg/*.pg-spec.ts`.

### Atomicidad

Con un fallo de auditoría inyectado, la operación completa se revierte y el reintento funciona en:

- crear caso;
- crear trabajo;
- confirmar período;
- confirmar cobro;
- aplicar propuesta;
- decidir HITL;
- crear alerta;
- `claim`, `complete` y `fail`.

Son fallos controlados; no se simuló la caída del servidor PostgreSQL.

### Rol restringido

`notihouse_app` se creó solo en esta base, con los SQL de `database/admin/`:

- La matriz `03-verify-app-privileges.sql` se cumple en las 18 tablas.
- Toda la suite se ejecutó con ese rol, incluido el login real.
- Se rechazaron 18 acciones prohibidas, entre ellas: crear, alterar o eliminar tablas; modificar o borrar auditoría; desactivar triggers; cambiar cuentas; leer migraciones; crear roles o bases; otorgarse privilegios.
- El rol no tiene `CREATE` en `public` ni `USAGE` en `drizzle`: las migraciones exigen otro rol.

## 7. Simulación de los flujos de n8n

Cliente HTTP con las rutas reales. Los "procesadores" devuelven fixtures fijos: no hubo OCR, IA ni transcripción.

| Flujo | Resultado | Límite del diseño actual |
|---|---|---|
| **A. PDF → propuesta → HITL → aplicación** | Completo. Sin período antes de aprobar; un `apply` doble crea 1; alerta, bandeja y dashboard coherentes; la auditoría se reconstruye por `correlation_id` | El último trabajo debe cerrar el caso **antes** de completarse: `cases/:id/complete` exige una reclamación vigente |
| **B. Audio → trabajo → propuesta `stt`** | Completo hasta la revisión. Audio privado; un worker vencido recibe 409 | Una transcripción aprobada **no se aplica** (400): falta una propuesta `llm` con una acción permitida |
| **C. Fallo y recuperación** | Completo. La respuesta tardía recibe 409 y la auditoría muestra al worker vigente | — |
| **D. Rechazo humano** | Completo. Sin cambios en obligaciones ni cobros; el `hitl.decision` informa del rechazo | — |

## 8. Defectos encontrados y corregidos

Todos se reprodujeron en PostgreSQL real antes de corregirlos. Corrida inicial: 26 fallos de 159, de los cuales 2 eran errores de mis pruebas y no del backend.

| # | Gravedad | Defecto y evidencia | Causa | Corrección | Regresión |
|---|---|---|---|---|---|
| D1 | **Alta** | Una decisión HITL retenida en un bloqueo **se aprobaba después de su fecha límite** (200 en lugar de 409) | `now()` es la hora de inicio de la transacción | Decidir y expirar usan `clock_timestamp()`, ya con el bloqueo tomado | `03-hitl-apply`: "retenida en un bloqueo" |
| D2 | **Alta** | Barridos de alertas paralelos se interbloqueaban: **18 de 20 respondían 409**. Parte de los 27 `deadlock detected` del log | Las fases bloquean alertas en órdenes distintos (por recurso y por id) | Bloqueo consultivo de transacción por lote | `05-alerts-dashboard`, `09-controlled-load` |
| D3 | Media | Dos `claim` con casos cruzados: `200, 409` por 40P01; el segundo worker perdía su lote | Casos bloqueados en orden de trabajo | Casos del lote bloqueados por id; vencidos en transacción propia | `01-workflow-jobs`: "casos cruzados" |
| D4 | Media | Se entregaba un trabajo de un caso cerrado durante la reclamación | El estado se leía antes del bloqueo y no se revisaba | Se comprueba con el caso bloqueado; el trabajo pasa a `cancelled` con auditoría | `01-workflow-jobs`: "caso cerrado" |
| D5 | Media | `complete` contradictorio devolvía 200 y ocultaba el error (pendiente desde 4.2C) | Solo se comparaba el token | Comparación `jsonb` en PostgreSQL; distinto → 409. Sin migración | Escenario C y `hardening.e2e-spec.ts` |
| D6 | Media | 4 arriendos solapados creados a la vez: `201 × 4` | Sin regla | Política de abajo | Escenario L y `rentals.e2e-spec.ts` |
| D7 | Baja | La suite podía apuntar a Neon con una confirmación manual | Barrera insuficiente | `target-guard.ts` | `target-guard.spec.ts`, `00-environment` |

Ejecución posterior: 0 `deadlock detected` en el servidor y 160/160 al cerrar la Fase 4.2F.2 (183/183 tras la revisión 4.2F.2.1, sección 12), también tras varias corridas seguidas con datos acumulados.

**Política de arriendos (D6).** El PDD no define unidades y el esquema no tiene esa entidad, y Neon tiene 0 solapes (consulta de solo lectura). Por eso se adoptó la política propuesta para el MVP: un inmueble es una unidad arrendable.

- No se admiten dos arriendos `active` o `suspended` que compartan algún día; `endsOn` nulo significa sin fin.
- Los intervalos consecutivos están permitidos, y `ended` no ocupa el inmueble.
- Se serializa con `FOR NO KEY UPDATE` sobre el inmueble, en el orden inmueble → arriendo, igual que los contratos.
- **No requirió migración.** Las 3 migraciones siguen intactas.

Si más adelante se modelan unidades, habrá que revisar esta regla.

**Cambio de contrato.** `POST` y `PATCH /rentals` ahora pueden responder 409, y `complete` contradictorio responde 409. Los fixtures e2e que creaban arriendos solapados se ajustaron; ninguna regla se relajó.

## 9. Carga controlada

Última ejecución limpia, con 2 instancias y un máximo de 10 conexiones. **Tiempos orientativos de este equipo con Docker local: no son una garantía para Render ni Neon.**

| Escenario | Solicitudes | Estados | Inesperados | p50 ms | Máx ms | Sesiones (pico) | En espera (pico) | Duplicados |
|---|---|---|---|---|---|---|---|---|
| 10 workers × 5 rondas, 40 trabajos | 50 | 200 | 0 | 13–90 | 99 | 10 | 0 | 0 |
| Clave de idempotencia | 20 | 19×200, 1×201 | 0 | 54 | 55 | 10 | 0 | 0 |
| Evaluaciones de alertas | 20 | 20×200 | 0 | 446 | 488 | 10 | 9 | 0 |
| Aplicación de propuesta | 10 | 9×200, 1×201 | 0 | 53 | 72 | 10 | 9 | 0 |
| Confirmar período | 10 | 10×200 | 0 | 25 | 33 | 10 | 9 | 0 |
| Confirmar cobro | 10 | 10×200 | 0 | 24 | 33 | 10 | 9 | 0 |
| Subidas, 5 usuarios | 10 | 10×201 | 0 | 52 | 57 | 5 | 0 | 0 |

## 10. Neon

Huella de solo lectura (`neon-readonly-snapshot.ts`) antes de empezar y al terminar:

| Dato | Antes | Después |
|---|---|---|
| SHA-256 global (conteos y `md5` de las 18 tablas, migraciones y triggers) | `de162b4d…2e01034b` | **idéntico** |
| Tablas / migraciones | 18 / 3 | 18 / 3 |
| `audit_events` / `auth_accounts` | 8 / 4 | 8 / 4 |

La huella resume también `auth_accounts`, así que cubre las cuentas demo y sus contraseñas sin mostrar datos. El volumen local parte de cero: nada se copió de Neon.

## 11. Limitaciones y decisiones abiertas

**Sin comprobar:**

- Contención a través del **pooler de Neon** y con su latencia. `pg_advisory_xact_lock` y `SET LOCAL` son compatibles con el modo transacción, pero no se ejecutó allí.
- Caída real del servidor PostgreSQL o de la red a mitad de una transacción.
- `FlakyStorage` simula el almacenamiento; S3 real sin probar.
- Las instancias de `conc:test` comparten un proceso Node. Solo los 10 escenarios de `conc:suite` usaron procesos separados.
- "Fallo durante la renovación" se aproximó con un cliente que aborta el `heartbeat` bloqueado.
- La repetición de `stale-worker` con espera real de 32 s fue una; las otras cuatro simulan el vencimiento con un fixture.

**Decisiones pendientes:**

| Tema | Situación | Recomendación |
|---|---|---|
| Barridos de alertas en paralelo | Ya no fallan, pero esperan ocupando una conexión del pool | Un solo scheduler en n8n |
| `complete` tras cerrar el caso | Orden obligatorio: cerrar el caso y luego completar el trabajo | Fijarlo en el workflow de n8n |

## 12. Revisión 4.2F.2.1

Tres revisiones previas al commit. Las pruebas se ejecutaron primero contra el código sin corregir: 12 de las 24 nuevas fallaron. Pruebas: `test/pg/10-lease-and-confirmation.pg-spec.ts`. Esta sección sustituye a la valoración anterior, que consideraba "aceptable" el plazo del arrendamiento sin haberlo probado.

| # | Gravedad | Defecto y evidencia | Causa | Corrección |
|---|---|---|---|---|
| D8 | Media | Con el arrendamiento vencido durante la espera de un bloqueo, respondían 200 o 201: `complete`, `heartbeat`, `fail`, propuesta, revisión, cierre y fallo de caso, y lectura de documento | `now()` es la hora de inicio de la transacción | La vigencia se comprueba con `clock_timestamp()` en una consulta **posterior** al bloqueo, y se revalida tras el bloqueo del caso. Responde 409 sin efectos |
| D9 | Baja | Repetir una confirmación de período con otra referencia, añadirla u omitirla respondía 200, también compitiendo (`200, 200`) | Solo se comparaba el resultado | Se compara también la referencia; distinta → 409 sin mutaciones ni eventos |

**Alcance real de D8.** No había dos titulares: el bloqueo de la fila impide que otro worker reclame mientras la operación espera, y el fencing se mantuvo. El defecto era aceptar una escritura, o renovar, con una autorización ya vencida. Ahora el trabajo sigue `claimed`, vencido y recuperable.

**Por qué no basta con `clock_timestamp()` en la misma consulta.** Las expresiones de un `SELECT … FOR UPDATE` se calculan antes de esperar la fila. Por eso la comprobación va en una consulta aparte.

**Dónde se conserva `now()` a propósito:**

| Uso | Motivo |
|---|---|
| Selección de candidatos en `claim` | Una hora anterior solo puede omitir un trabajo recién vencido; se recoge en la siguiente reclamación |
| Base del nuevo plazo en `claim` y `heartbeat` | Tras una espera, el plazo resulta algo más corto: es conservador y el worker lo ve en `lockedUntil` |
| `findClaimed` y la columna informativa `leaseActive` | Son consultas sin espera de bloqueo |

**HITL.** El guardián efectivo de D1 es el `UPDATE` condicionado con `clock_timestamp()`. Si la lectura previa quedara desactualizada, el resultado sigue siendo 409.

**Comprobado que no se rompe:**

- operación retenida con el arrendamiento aún vigente → se acepta;
- reintento idéntico de un trabajo completado, aunque pase el tiempo → 200;
- resultado contradictorio → 409;
- `fail` duplicado → 200 sin contar otro intento;
- estado terminal → prevalece;
- worker antiguo → 409.

**Dependencias.** `GHSA-g3hv-75wg-m249` (`minimatch` < 11.0.1, moderada) se publicó el 2026-10-30, y `@nestjs/cli` 12.0.11, la última versión, sigue fijando 10.2.6. El arreglo de `npm audit fix --force` degradaría el CLI a la versión 11, así que se aplicó un override limitado a `@nestjs/cli` → `minimatch` 11.0.4.

- **Compatibilidad comprobada:** el CLI solo usa `minimatch(path, pattern, { dot })`; 800 combinaciones de patrones dieron 0 diferencias entre 10.2.6 y 11.0.4; `nest build` con copia real de assets y exclusiones copió los 16 archivos esperados.
- **Node:** 11.0.4 exige Node 20 o ≥ 22; el proyecto usa 24.
- **Retirar el override** cuando `@nestjs/cli` adopte una versión corregida.
