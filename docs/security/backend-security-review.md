# Revisión de seguridad del backend (Fase 4.2F.1)

Revisión integral del backend NestJS antes de las integraciones reales (n8n, Gmail, STT, IA, FCM) y del despliegue en Render. Fecha: 2026-10-29. Rama `develop`, a partir del commit `7e30edf`.

**Clasificación usada:**

| Etiqueta | Significado |
|---|---|
| **VERIFICADO** | Comprobado con evidencia suficiente: pruebas automatizadas, código o consultas de solo lectura en Neon. |
| **CORREGIDO** | Defecto encontrado, corregido y cubierto por una prueba de regresión. |
| **PENDIENTE DE VALIDACIÓN REAL** | Requiere Neon con escrituras, Render, S3 o un proveedor externo. |
| **REQUIERE DECISIÓN** | Hay alternativas legítimas y hay que elegir una. |
| **BLOQUEANTE** | Impide publicar el backend de forma segura. |

**Alcance de las pruebas.** Las pruebas automatizadas usan **PGlite**: PostgreSQL real en memoria, pero con una sola conexión. Demuestran la lógica, las restricciones y los privilegios. No demuestran contención entre conexiones: eso se comprobó en la Fase 4.2F.2 sobre PostgreSQL 18 local y descartable ([resultados](../testing/postgres-concurrency-results.md)). No se escribió nada en Neon; las comprobaciones allí fueron de solo lectura (`BEGIN READ ONLY`).

## 1. Autenticación

| Aspecto | Estado | Evidencia |
|---|---|---|
| Login con correo y contraseña Argon2id, mismo mensaje para cualquier fallo y tiempo constante (hash ficticio) | VERIFICADO | `auth.service.ts`, `auth.e2e-spec.ts` |
| JWT HS256 de 30 min; algoritmo, `iss`, `aud`, firma y expiración verificados; `alg: none` rechazado | VERIFICADO | `jwt-auth.guard.ts`, `auth.e2e-spec.ts` |
| Cuenta inactiva → 401 inmediato (el guard consulta la cuenta en cada solicitud) | VERIFICADO | `auth.e2e-spec.ts` |
| Sin registro público ni recuperación de contraseña | VERIFICADO | Prueba sobre `/auth/register` y `/auth/signup`; inventario de Swagger |
| Invalidación de tokens en el mismo segundo de un cambio de contraseña | **CORREGIDO** | Ver 1.1 |
| Login de los cuatro usuarios en Neon tras la corrección | VERIFICADO | Servidor local contra Neon: 4 × 200 en login y `/auth/me`; el login no escribe |

### 1.1 Defecto: tokens del mismo segundo (CORREGIDO)

- **Causa.** El guard rechazaba un token si `iat < floor(password_changed_at)`. Como `iat` tiene precisión de segundos, un token emitido antes del cambio pero dentro del mismo segundo tiene un `iat` igual al segundo truncado del cambio, así que se aceptaba.
- **Consecuencia.** Un token robado o anterior a una rotación seguía siendo válido hasta 30 minutos si se emitió en el mismo segundo en que cambió la contraseña. La ventana es estrecha pero real, y crece con procesos automatizados de rotación.
- **Reproducción.** `auth.e2e-spec.ts › password change within the same second`. Con el código anterior respondía 200; ahora responde 401.
- **Corrección, sin migración.** Cada JWT lleva el claim `sv` (versión de sesión): una huella opaca de 22 caracteres, SHA-256 de `profileId:password_changed_at` con precisión de milisegundos (`src/auth/session-version.ts`). El guard exige `sv` y que coincida con el valor vigente en la base.
  - Cualquier cambio de contraseña invalida todas las sesiones anteriores, sea cual sea el segundo.
  - Tras el despliegue, los tokens previos sin `sv` dejan de valer (falla cerrada): como máximo obliga a iniciar sesión de nuevo, porque los tokens duran 30 minutos.
- **Alternativa descartada.** Usar `iat <= cambio` habría rechazado también inicios de sesión legítimos realizados justo después del cambio en el mismo segundo.
- **Alternativa futura.** Un contador `token_version` en `auth_accounts` tendría el mismo efecto, pero exige una migración. No es necesario.

## 2. Autorización por propietario

| Aspecto | Estado | Evidencia |
|---|---|---|
| El propietario sale solo del JWT (`@CurrentUser()`); ningún DTO acepta `ownerId`; `forbidNonWhitelisted` devuelve 400 ante campos extra | VERIFICADO | Inventario de DTO; pruebas `?ownerId=…` → 400 |
| Todas las consultas de lista y detalle filtran por `owner_id` en SQL (21 controladores revisados) | VERIFICADO | Revisión de los `where` de todos los servicios; pruebas de aislamiento por módulo |
| Relaciones cruzadas verificadas (inmueble, obligación, arriendo, contrato, documento, caso) y respaldadas por FKs compuestas | VERIFICADO | `assertAssignableProperty`, `assertOwnedSubject`, `findObligation`/`findRental` |
| Recursos ajenos → 404, sin diferencias en conteos ni agregados | VERIFICADO | Pruebas e2e de cada módulo, alertas, bandeja y dashboard |
| Ningún PATCH cambia propietarios, `confirmed_by`/`confirmed_at` ni estados protegidos | VERIFICADO | Los DTO de actualización solo admiten `status: cancelled` en períodos y cobros; los contratos tienen transiciones validadas |
| Rutas públicas: solo `/health`, `/health/ready` y `/auth/login` | VERIFICADO | Prueba de inventario de Swagger (`auth.e2e-spec.ts`) |

## 3. Token de servicio (n8n)

| Aspecto | Estado | Evidencia |
|---|---|---|
| `@ServiceRoute()` prevalece sobre `@Public()`; las rutas internas solo aceptan el token de servicio | VERIFICADO | `jwt-auth.guard.ts`, pruebas unitarias y e2e |
| Comparación en tiempo constante (SHA-256 + `timingSafeEqual`, sin filtrar la longitud) | VERIFICADO | `service-token.verifier.ts` |
| JWT de usuario en una ruta interna → 401; token de servicio en una ruta de usuario → 401 | VERIFICADO | e2e y Neon (HTTP local) |
| Las escrituras sobre casos exigen la reclamación vigente de un trabajo de ese caso; el propietario sale del caso | VERIFICADO | `case-process.service.ts`, `hardening.e2e-spec.ts` |
| Un worker antiguo no escribe tras una nueva reclamación (fencing) | VERIFICADO | `hardening.e2e-spec.ts`, `workflow-jobs.e2e-spec.ts` |
| Documentos para el worker: reclamación vigente, mismo propietario y tipo de trabajo autorizado; el UUID no basta | VERIFICADO | `documents.service.ts › openForWorker`, `ingestion-worker.e2e-spec.ts` |
| El token de servicio no puede confirmar pagos ni cobros, renovar contratos ni aplicar propuestas | VERIFICADO | No existen rutas internas para eso; la aplicación de propuestas es solo para JWT (`proposal-application.e2e-spec.ts`) |
| El token no aparece en logs, errores ni Swagger | VERIFICADO | Revisión de código y del log del servidor local |

### 3.1 Rotación de `N8N_SERVICE_TOKEN` (diseño, no ejecutada)

Hoy hay un único token. Para rotarlo sin una ventana insegura:

1. Generar el nuevo valor localmente: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Nunca se pega en chats, tickets ni el repositorio.
2. **Variante simple (corte breve, MVP):**
   1. Detener los workflows programados en n8n.
   2. Actualizar la credencial en n8n y la variable en Render.
   3. Reiniciar el backend.
   4. Reactivar los workflows.

   Los trabajos reclamados que no terminen se recuperan cuando vence su arrendamiento.
3. **Variante sin corte (requiere un cambio menor de código):** aceptar temporalmente dos valores (`N8N_SERVICE_TOKEN` y `N8N_SERVICE_TOKEN_NEXT`), migrar n8n y retirar el anterior. Es una **decisión pendiente**.
4. Tras la rotación, comprobar que el valor anterior responde 401 en una ruta interna.

Se requiere `N8N_SERVICE_TOKEN ≠ JWT_SECRET`; la validación de entorno lo exige.

## 4. Secretos y credenciales

| Aspecto | Estado | Evidencia |
|---|---|---|
| `backend/.env` y `backend/.local/` ignorados por Git y no versionados | VERIFICADO | `git check-ignore`, `git ls-files` |
| Sin secretos en archivos versionables (230 archivos) ni en el historial de Git | VERIFICADO | Escaneo que usa los valores locales como patrón sin imprimirlos: 0 coincidencias de la contraseña demo y de los valores de `.env`, en el árbol y en `git log -p --all` |
| **El repositorio está dentro de OneDrive** | **REQUIERE DECISIÓN** | Ver 4.1 |
| Las cuatro cuentas demo comparten una contraseña temporal débil, que además apareció en salidas locales de sesiones anteriores | **BLOQUEANTE** para un despliegue público | Ver 4.2 |
| Rol `neondb_owner` usado por la API | **BLOQUEANTE** para producción | Ver sección 6 |

### 4.1 Riesgo de sincronización (OneDrive)

`backend/.env` (cadenas de Neon, `JWT_SECRET`, `N8N_SERVICE_TOKEN`) y `backend/.local/demo-credentials.txt` están en una carpeta sincronizada por OneDrive. `.gitignore` no los protege de esa sincronización:

- quedan copiados en la nube de Microsoft y en otros equipos vinculados;
- quedan en el historial de versiones de OneDrive, incluso después de borrarlos;
- se comparten si alguien comparte la carpeta.

Recomendación:

- Mover el clon de trabajo fuera de OneDrive (p. ej. `C:\dev\notihouse-pal`), o excluir las carpetas de la sincronización.
- Tratar los secretos actuales como potencialmente expuestos y rotarlos antes de producción (Fase 4.2F.3): contraseña de Neon, `JWT_SECRET`, `N8N_SERVICE_TOKEN` y contraseñas demo.
- Borrar `demo-credentials.txt` una vez guardadas las credenciales en un gestor de contraseñas.

El script de rotación rechaza escribir credenciales en rutas de OneDrive, Dropbox, iCloud o dentro del repositorio.

### 4.2 Rotación de las contraseñas demo (preparada, no ejecutada)

Herramientas: `npm run db:demo:rotate-passwords`, con el script `src/database/scripts/rotate-demo-passwords.ts` y la lógica en `src/database/seed/password-rotation.ts`.

**Garantías:**

- Genera una contraseña aleatoria **individual** por cuenta (18 bytes, 24 caracteres). Nunca las recibe por argumentos ni variables de entorno y nunca las imprime.
- Es una **simulación por defecto**. Solo escribe si `CONFIRM_PASSWORD_ROTATION` es igual al nombre de la base conectada.
- Guarda las contraseñas en `ROTATION_OUTPUT_FILE`, una ruta absoluta y nueva, fuera del repositorio y de carpetas sincronizadas, con permisos solo para el usuario. Lo hace **antes** del commit, marcadas como PENDIENTE.
- Usa **una transacción** para las cuatro cuentas: cambian todas o ninguna. Cada cuenta recibe un hash Argon2id propio, `password_changed_at = clock_timestamp()` y un evento de auditoría `auth_account.password_rotate` sin contraseñas ni hashes.
- El cambio de `password_changed_at` invalida todos los JWT anteriores (claim `sv`).
- Probado en PGlite (`password-rotation.spec.ts`): atomicidad, ausencia de secretos en la auditoría, sesiones invalidadas y rutas de salida rechazadas.

**Procedimiento (Fase 4.2F.3, con la persona responsable):**

1. Mover el clon fuera de OneDrive, o usar un equipo sin sincronización.
2. Comprobar `npm run db:check`: 18 tablas y 3 migraciones.
3. Simulación:
   ```bash
   ROTATION_OUTPUT_FILE=<ruta absoluta nueva> npm run db:demo:rotate-passwords
   ```
4. Ejecución real con `CONFIRM_PASSWORD_ROTATION=neondb` y la misma variable de salida.
5. Probar el login de las cuatro cuentas con las contraseñas nuevas y comprobar que la anterior responde 401.
6. Pasar las credenciales a un gestor de contraseñas y borrar el archivo de salida y `backend/.local/demo-credentials.txt`.

**Recuperación:**

| Situación | Qué hacer |
|---|---|
| Falla antes de escribir el archivo | No cambió nada. |
| Falla la transacción | Lo normal es que no cambie nada (rollback). El archivo `.pending` se conserva porque un corte durante el COMMIT deja el resultado incierto. Probar el login: si la contraseña anterior funciona, borrar el `.pending`; si funciona la nueva, el `.pending` contiene las vigentes. |
| Commit correcto pero falla el renombrado | El `.pending` contiene las contraseñas vigentes. |
| Cualquier duda | Repetir la rotación completa: genera un juego nuevo y no depende del anterior. |

## 5. Rate limiting, CORS y proxy

| Aspecto | Estado | Evidencia |
|---|---|---|
| Login limitado a 5 intentos por minuto y por IP; responde 429 | VERIFICADO | `auth.e2e-spec.ts` |
| `X-Forwarded-For` falsificado no evade el límite (por defecto no se confía en ningún proxy) | VERIFICADO | `auth.e2e-spec.ts › ignores spoofed X-Forwarded-For` |
| Política explícita de proxy: `TRUST_PROXY_HOPS` (0 a 3, nunca `true`) | **CORREGIDO** | Antes, detrás de Render todas las solicitudes compartirían la IP del proxy y un cliente podía bloquear el login de todos. `production-config.e2e-spec.ts`: con 1 salto, otro cliente no queda bloqueado y anteponer una IP falsa no evade el límite. |
| Valor correcto de `TRUST_PROXY_HOPS` en Render | PENDIENTE DE VALIDACIÓN REAL | Ver render-readiness.md |
| CORS: un único origen (`FRONTEND_URL`, sin comodín ni ruta), sin credenciales, métodos `GET,POST,PATCH`, cabeceras `Authorization, Content-Type, X-Correlation-Id`; expone `X-Correlation-Id` | **CORREGIDO** (antes permitía cualquier método y cabecera, y no exponía el correlation id) | `app.e2e-spec.ts`, `production-config.e2e-spec.ts` |
| Contador del rate limit en memoria: con varias instancias cada una cuenta por separado (el límite efectivo es N × 5) | REQUIERE DECISIÓN | Para el MVP con una instancia es aceptable; con varias, almacenamiento compartido (Redis o PostgreSQL). |
| Límites de subida: 2 simultáneas por usuario y 10 por proceso, más límites de tamaño; sin límite por minuto | REQUIERE DECISIÓN | Recomendación: añadir un throttler por usuario a `/ingestions/*` (p. ej. 20/h) antes de abrir a usuarios reales. |
| Rutas internas y evaluación de alertas: sin rate limit (solo el token de servicio) | VERIFICADO (aceptado) | La evaluación es idempotente y procesa por lotes. |

## 6. Rol PostgreSQL restringido

**Estado actual (Neon, solo lectura):**

- La API usa `neondb_owner`: dueño de las 18 tablas, con `CREATEROLE`, `BYPASSRLS` y miembro de `neon_superuser`.
- Puede alterar el esquema, desactivar el trigger append-only de `audit_events` (`ALTER TABLE … DISABLE TRIGGER`) y crear roles.
- El rol `notihouse_app` no existe. `PUBLIC` no puede crear objetos en `public`.

**BLOQUEANTE para producción.**

### 6.1 Inventario de privilegios (derivado del código)

| Tablas | Privilegios |
|---|---|
| `profiles`, `auth_accounts`, `providers`, `provider_payment_links` | `SELECT` |
| `properties`, `obligations`, `obligation_occurrences`, `rentals`, `rent_charges`, `contracts`, `cases`, `case_proposals`, `hitl_requests`, `workflow_jobs`, `alerts` | `SELECT, INSERT, UPDATE` |
| `documents` | `SELECT, INSERT` y `UPDATE (updated_at)`: necesario para `FOR SHARE`; no permite tocar `storage_key` |
| `audit_events`, `proposal_applications` | `SELECT, INSERT` |
| Esquema `public` | `USAGE` (sin `CREATE`) |
| Esquema `drizzle` (migraciones) | ninguno |

Ningún servicio usa `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, secuencias ni funciones propias. Los UUID usan `gen_random_uuid()`, ejecutable por `PUBLIC`.

### 6.2 SQL preparado (`database/admin/`, no ejecutado)

| Archivo | Contenido |
|---|---|
| `01-create-app-role.sql` | `notihouse_app` `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, límite de conexiones y `statement_timeout`/`idle_in_transaction_session_timeout`. **Sin contraseña.** |
| `02-grant-app-privileges.sql` | `REVOKE ALL` seguido de los GRANT del inventario. Es idempotente y debe repetirse tras cada migración que agregue tablas. |
| `03-verify-app-privileges.sql` | Matriz esperada contra `has_table_privilege`, en solo lectura. |
| `99-rollback-app-role.sql` | Retira privilegios y el rol. |

**Pruebas (PGlite):**

- `app-role.spec.ts` (18 pruebas):
  - la matriz coincide en las 18 tablas;
  - las operaciones permitidas funcionan;
  - se deniegan `DELETE`, `TRUNCATE`, `UPDATE`/`DELETE` de auditoría, cambio de hash, alta de perfiles, cambio de `storage_key`, `CREATE`, `ALTER`, `DROP`, `DISABLE TRIGGER`, lectura de `drizzle.__drizzle_migrations` y `CREATE ROLE`;
  - un `GRANT` del propio rol no concede nada.
- `app-role.e2e-spec.ts`: **la API completa con la sesión en `notihouse_app`**. Cubre login, negocio, confirmaciones humanas, cola, propuestas, HITL, aplicación, ingesta, descarga del worker, alertas, bandeja y dashboard. Demuestra que el inventario basta.

### 6.3 Procedimiento (Fase 4.2F.3)

1. Como `neondb_owner`: ejecutar `01` y `02` (psql, una transacción cada uno) y `03` (sin filas con `ok = false`).
2. Asignar la contraseña sin que quede en SQL ni en el historial: consola de Neon (*Roles → Reset password*) o `\password notihouse_app` en psql. Después: `ALTER ROLE notihouse_app LOGIN;`.
3. Construir la nueva `DATABASE_URL` (pooler) con `notihouse_app` y probarla localmente: arrancar la API con esa cadena y comprobar `/api/v1/health/ready` y un inicio de sesión. `npm run db:check` sigue usando `DATABASE_URL_DIRECT` (propietario) y no prueba el rol nuevo.
4. Cambiar `DATABASE_URL` en Render y reiniciar. `DATABASE_URL_DIRECT` (migraciones) sigue siendo `neondb_owner` y no se carga en Render.
5. **Reversión:** volver a la `DATABASE_URL` anterior y reiniciar. Luego, si se desea, `99-rollback-app-role.sql`. Ningún paso toca datos.
6. Tras cada migración futura: volver a ejecutar `02` y `03`.

En Neon, la creación de roles también puede hacerse desde la consola o la API. Si la consola crea el rol con privilegios por defecto amplios, `02` los reduce, porque empieza con `REVOKE ALL`.

## 7. Row-Level Security

**Estado:** RLS desactivado en las 18 tablas (Neon, solo lectura).

**Recomendación: implementar más adelante, no ahora (REQUIERE DECISIÓN para la fecha).** Motivos:

1. **Pool y contexto.** Con `pg.Pool`, el propietario debería fijarse por transacción con `SET LOCAL app.owner_id = …` (o `set_config(..., true)`) dentro de **cada** transacción. Hoy muchas lecturas no usan transacción explícita. Un `SET` de sesión, sin `LOCAL`, contaminaría las conexiones reutilizadas del pool. Habría que envolver todas las consultas de usuario en transacciones, un cambio transversal.
2. **Servicios internos.** Las rutas de n8n operan por caso o trabajo, sin propietario previo. Necesitarían políticas específicas, otro rol o `BYPASSRLS`, y eso debilita el beneficio.
3. **Scripts administrativos y migraciones.** Corren como el dueño de las tablas, que ignora RLS salvo con `FORCE ROW LEVEL SECURITY`. Además, `neondb_owner` tiene `BYPASSRLS`.
4. **Barreras actuales:**
   - filtros `owner_id` en todas las consultas, revisados;
   - FKs compuestas `(id, owner_id)`, que impiden **relacionar** registros de propietarios distintos;
   - pruebas de aislamiento en cada módulo;
   - rol restringido, que limita el daño de una inyección o de un error.

   Las FKs compuestas **no sustituyen** a RLS: no impiden **leer** filas ajenas si una consulta omite el filtro. Solo garantizan coherencia de propiedad en las relaciones.

**Orden sugerido:**

1. Rol restringido (Fase 4.2F.3).
2. Revisión de código obligatoria de cada consulta nueva, con la prueba de aislamiento como patrón.
3. RLS después del MVP, empezando por las tablas de lectura del usuario y usando `SET LOCAL` en una transacción por solicitud (interceptor).

## 8. Integridad, concurrencia e idempotencia

| Aspecto | Estado | Evidencia |
|---|---|---|
| Reclamación con `FOR UPDATE … SKIP LOCKED`: un trabajo no queda en dos reclamaciones | VERIFICADO (PostgreSQL 18 local) / PENDIENTE en el pooler de Neon | `test/pg/01-workflow-jobs.pg-spec.ts` |
| Fencing con token de reclamación (huella en `locked_by`); el worker antiguo recibe 409 | VERIFICADO | `hardening.e2e-spec.ts`, `workflow-jobs.e2e-spec.ts` |
| `complete` repetido de la misma reclamación: idempotente, sin doble transición ni doble auditoría | VERIFICADO | `hardening.e2e-spec.ts` |
| `complete` repetido con un `result` **distinto**: 409 sin cambios | **CORREGIDO** (4.2F.2) | Ver 8.1 |
| Retransmisión tardía de una propuesta ya reemplazada | **CORREGIDO** | Ver 8.2 |
| HITL: plazo de 24 h con el reloj de PostgreSQL; una revisión vencida nunca aprueba; decisiones contradictorias → 409; mismas decisiones → idempotentes | VERIFICADO | `hitl.e2e-spec.ts`; escenario `contradictory-hitl` |
| Aplicación de propuestas exactamente una vez (bloqueo del caso + `UNIQUE(proposal_id)`) | VERIFICADO (PostgreSQL 18 local) / PENDIENTE en el pooler de Neon | `test/pg/03-hitl-apply.pg-spec.ts` |
| Cambios de estado y auditoría en la misma transacción; un fallo de auditoría revierte todo | VERIFICADO | Pruebas con un `AuditService` que falla en cada módulo |
| Limpieza de temporales antes de responder (Fase 4.2E.1) | VERIFICADO | `upload-cleanup.e2e-spec.ts` |
| Solapamiento de arriendos en un mismo inmueble | **CORREGIDO** (4.2F.2) | Ver 8.3 |
| Decisión HITL retenida en un bloqueo más allá del plazo | **CORREGIDO** (4.2F.2) | `clock_timestamp()`; `test/pg/03-hitl-apply.pg-spec.ts` |
| Interbloqueos en barridos de alertas y en `claim` con casos cruzados | **CORREGIDO** (4.2F.2) | `test/pg/05-alerts-dashboard.pg-spec.ts`, `01-workflow-jobs.pg-spec.ts` |

### 8.1 `complete` con resultado contradictorio

- **Situación.** Un `complete` repetido con la misma reclamación devuelve 200 y el `result` **original**. Un segundo `result` distinto se descarta sin aviso. No hay doble ejecución porque `result` es técnico y no modifica datos de negocio.
- **Riesgo.** Un error de n8n, por ejemplo dos ramas que completan con datos diferentes, quedaría oculto.
- **Opciones:**
  - (a) Mantener: máxima tolerancia a reintentos.
  - (b) Responder **409** si `result` difiere (comparación `jsonb`) y 200 si es igual. Los reintentos de n8n reenvían el mismo cuerpo, así que no se rompen.
- **Decisión (Fase 4.2F.2): (b).** Una repetición idéntica es idempotente y una contradictoria responde 409. Comparación `jsonb` en PostgreSQL, sin migración.

### 8.2 Defecto: propuesta tardía que reemplazaba a la vigente (CORREGIDO)

- **Causa.** La deduplicación comparaba solo con la **última** versión. Una retransmisión tardía de la versión 1, después de existir la 2, creaba una versión 3 idéntica a la 1 y marcaba la 2 como `superseded`. Así revivía un contenido reemplazado y anulaba la revisión pendiente de la versión vigente.
- **Requisitos para que ocurra:** la reclamación vigente del trabajo, es decir, reintentos HTTP fuera de orden del mismo worker. El fencing ya rechazaba a los workers antiguos.
- **Corrección.** Se compara con **todas** las versiones del caso. Un contenido ya registrado devuelve esa versión (200) con su estado real (p. ej. `superseded`) y no crea ni reemplaza nada.
- **Prueba.** `hardening.e2e-spec.ts › a delayed retransmission of an earlier version does not revive it`. Antes respondía 201; ahora 200.
- **Efecto colateral aceptado.** Si la IA vuelve a proponer exactamente un contenido ya rechazado, recibe esa versión rechazada en lugar de una nueva pendiente. Es coherente: el usuario ya decidió sobre esos datos.

### 8.3 Solapamiento de arriendos

- **Situación.** El esquema y el servicio permiten dos arriendos con fechas superpuestas para el mismo inmueble. En Neon hay hoy 0 solapamientos (2 arriendos en 2 inmuebles).
- **Qué no se sabe.** El modelo no define si un inmueble es una unidad arrendable única o si puede contener varias unidades (habitaciones, locales). El esquema no tiene una entidad "unidad".
- **Impacto si es involuntario.** Cobros esperados duplicados en el dashboard (montos inflados), alertas duplicadas por inmueble y contratos ambiguos.
- **Recomendación para el MVP:** tratar el inmueble como unidad única y rechazar con **409** un arriendo `active`/`suspended` que se superponga con otro no `ended` del mismo inmueble.
  - Debe ser una validación conservadora en el servicio, dentro de la transacción y con `FOR UPDATE` sobre el inmueble para evitar carreras.
  - No aplica a arriendos `ended`.
  - Más adelante, si se modelan unidades, una restricción `EXCLUDE USING gist` sobre `(property_id, daterange)`.

  **Implementado en la Fase 4.2F.2**, con `FOR NO KEY UPDATE` sobre el inmueble y sin migración. Neon tiene 0 solapes (consulta de solo lectura).

## 9. Archivos y almacenamiento

| Aspecto | Estado | Evidencia |
|---|---|---|
| Sin rutas estáticas; contenido solo por endpoints autenticados (propietario o worker con reclamación) | VERIFICADO | `ingestion-http.e2e-spec.ts`, `ingestion-worker.e2e-spec.ts` |
| Claves internas validadas y contenidas en la raíz (sin path traversal); `wx`/`IfNoneMatch: '*'` contra sobrescritura | VERIFICADO (local) / adaptador S3 probado con dobles | `local-file-storage.spec.ts`, `s3-file-storage.spec.ts` |
| Streaming, límites de tamaño en el flujo y firma, MIME y extensión coherentes | VERIFICADO | `file-policy.spec.ts`, `ingestion.e2e-spec.ts` |
| Audio: validación estructural propia (WebM, M4A, Ogg, WAV, MP3), rechazo de archivos solo con video y límites de parseo (cajas y elementos) | VERIFICADO con grabaciones sintéticas | `audio-structure.spec.ts`, fixtures |
| PDF: rechazo heurístico de contenido activo (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile(s)`, `/RichMedia`, `/XFA`). **No es antimalware ni sanitización** | **REQUIERE DECISIÓN** antes de aceptar PDF de terceros reales | Ver 9.1 |
| Compensación: si PostgreSQL falla tras guardar el archivo, se borra el objeto; si el borrado falla, queda huérfano y se registra | VERIFICADO (local) | `ingestion.e2e-spec.ts` |
| Bucket S3 real, `IfNoneMatch` del proveedor y credenciales de permisos mínimos | PENDIENTE DE VALIDACIÓN REAL | render-readiness.md, sección de almacenamiento |
| Limpieza periódica de objetos huérfanos | REQUIERE DECISIÓN | Hoy solo hay registro. Propuesta: tarea que compare claves del bucket con `documents.storage_key` y borre huérfanos con más de 24 h. |

### 9.1 PDF no confiables

Antes de procesar PDF reales de terceros (Gmail):

- **Análisis antimalware fuera del proceso de la API**, por ejemplo ClamAV en un contenedor o el análisis del proveedor de almacenamiento, en el workflow `document.process` y antes del OCR o la IA. No se agrega ninguna dependencia ahora.
- **Extracción de texto en un entorno aislado** (worker de n8n o servicio OCR), nunca en el proceso de la API.
- **No servir PDF al navegador inline.** Las descargas ya usan `Content-Disposition: attachment`; mantenerlo.

## 10. Auditoría

| Aspecto | Estado |
|---|---|
| `audit_events` append-only (triggers que rechazan `UPDATE`, `DELETE` y `TRUNCATE`; presentes en Neon) | VERIFICADO |
| Con el rol restringido, la API tampoco tiene privilegio para modificar la auditoría ni desactivar triggers | VERIFICADO (PostgreSQL 18 local) / PENDIENTE en Neon: el rol aún no existe allí |
| Eventos sin contraseñas, hashes, tokens ni contenido documental | VERIFICADO (pruebas por módulo y de la rotación) |
| `correlation_id` en toda la cadena caso → propuesta → HITL → aplicación | VERIFICADO |

## 11. Errores y logging

| Aspecto | Estado |
|---|---|
| Errores 500 sin stack ni detalles en la respuesta; errores de PostgreSQL traducidos a 400, 409 o 503 sin SQL | VERIFICADO |
| Fallos de almacenamiento → 503 sin detalles del proveedor | VERIFICADO |
| Readiness sin host, error ni credenciales | VERIFICADO (`app.e2e-spec.ts`) |
| Log del servidor local contra Neon sin tokens, contraseñas ni cadenas de conexión | VERIFICADO (escaneo del log) |
| Mensajes de validación de entorno sin valores de secretos | VERIFICADO (`env.validation.spec.ts`) |

## 12. Riesgos abiertos

| Riesgo | Clasificación |
|---|---|
| API con `neondb_owner` | BLOQUEANTE (Fase 4.2F.3) |
| Contraseña demo compartida, débil y expuesta en salidas locales | BLOQUEANTE para un despliegue público |
| Secretos locales sincronizados por OneDrive | REQUIERE DECISIÓN (mover el clon y rotar) |
| Almacenamiento S3 real no configurado (el local está prohibido en producción) | BLOQUEANTE para ingesta en producción |
| Contención real entre conexiones | VERIFICADO en PostgreSQL 18 local; pendiente en el pooler de Neon |
| `TRUST_PROXY_HOPS` en Render | PENDIENTE DE VALIDACIÓN REAL |
| Rate limit en memoria con varias instancias | REQUIERE DECISIÓN |
| PDF no confiables sin antimalware | REQUIERE DECISIÓN (antes de Gmail) |
| RLS | REQUIERE DECISIÓN (recomendado después del MVP) |
