# Preparación del backend para Render (Fase 4.2F.1)

Estado: **preparado, no desplegado.** No se conectó GitHub a Render ni se creó ningún servicio. Este documento lista lo que el backend ya soporta, la configuración exacta y lo que falta para publicarlo de forma segura.

Clasificación: **VERIFICADO**, **PENDIENTE DE VALIDACIÓN REAL**, **REQUIERE DECISIÓN** y **BLOQUEANTE** (ver [backend-security-review.md](../security/backend-security-review.md)).

## 1. Servicio

| Parámetro | Valor | Estado |
|---|---|---|
| Tipo | Web Service, runtime Node | — |
| Root Directory | `backend` | VERIFICADO (monorepositorio) |
| Node | 24 (`backend/.node-version`; también `NODE_VERSION=24`) | VERIFICADO localmente con Node 24.22 |
| Build Command | `npm ci --include=dev && npm run build` | VERIFICADO localmente (`nest build`) |
| Start Command | `npm run start:prod` (`node dist/main`) | VERIFICADO localmente |
| Health Check Path | `/api/v1/health` | VERIFICADO |
| Auto-Deploy | Desactivado hasta cerrar los bloqueantes | REQUIERE DECISIÓN |
| Instancias | 1 (ver rate limiting) | REQUIERE DECISIÓN |

- `--include=dev` es necesario: si Render define `NODE_ENV=production` durante la compilación, `npm ci` omitiría las devDependencies (nest CLI y TypeScript) y fallaría el build.
- Blueprint opcional en `infra/render/render.yaml`. Está fuera de la raíz a propósito: solo se usa si se crea un Blueprint indicando esa ruta. No contiene secretos (`sync: false`).
- No se ejecutan migraciones al arrancar, y no deben añadirse al build ni al start. Las migraciones se aplican con el procedimiento versionado y el rol propietario.

## 2. Puerto y host

`main.ts` escucha en `PORT` (validado entre 1 y 65535) y en `0.0.0.0`. Render inyecta `PORT`, y localmente el valor por defecto es 3000. `enableShutdownHooks()` cierra el pool de PostgreSQL ante `SIGTERM`. **VERIFICADO.**

## 3. Variables de entorno

| Variable | Tipo | Producción | Notas |
|---|---|---|---|
| `NODE_ENV` | config | `production` | Desactiva Swagger y exige secretos y S3 |
| `PORT` | config | La define Render | — |
| `FRONTEND_URL` | config | Origen exacto del frontend en Vercel | Un solo origen, sin ruta ni comodín. El dominio aún no existe: **REQUIERE DECISIÓN** |
| `DATABASE_URL` | **secreto** | Neon con pooling, rol `notihouse_app` | **BLOQUEANTE** mientras use `neondb_owner` |
| `DATABASE_URL_DIRECT` | **secreto** | **No** se carga en Render | Solo para migraciones y scripts administrativos |
| `JWT_SECRET` | **secreto** | ≥ 43 caracteres aleatorios, nuevo para producción | Rotarlo (estuvo en una carpeta sincronizada) |
| `N8N_SERVICE_TOKEN` | **secreto** | ≥ 43 caracteres aleatorios, ≠ `JWT_SECRET` | Obligatorio en producción |
| `TRUST_PROXY_HOPS` | config | Ver sección 5 | 0 por defecto |
| `STORAGE_DRIVER` | config | `s3` (`local` rechazado en producción) | — |
| `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION` | config | Bucket privado | **BLOQUEANTE**: no existe |
| `STORAGE_S3_ENDPOINT` | config | Solo para proveedores compatibles (https) | — |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | **secreto** | Credenciales de permisos mínimos | Van juntas |
| `STORAGE_S3_FORCE_PATH_STYLE` | config | Según el proveedor | — |
| `STORAGE_MAX_PDF_BYTES`, `STORAGE_MAX_AUDIO_BYTES` | config | 10 MiB / 25 MiB | Techos: 50 / 100 MiB |
| `STORAGE_UPLOAD_TMP_PATH` | config | Por defecto, el tmp del sistema | Disco efímero: solo temporales |
| `DUE_DATES_TIME_ZONE`, `DUE_DATES_*` | config | `America/Bogota`, 7, 7, 30, 6 | Parámetros operativos del MVP |

La validación de entorno impide arrancar con:

- variables obligatorias ausentes;
- secretos cortos o de ejemplo;
- `N8N_SERVICE_TOKEN = JWT_SECRET`;
- almacenamiento local en producción;
- un endpoint S3 sin https;
- `FRONTEND_URL` inválido;
- un puerto fuera de rango;
- `TRUST_PROXY_HOPS` fuera de 0 a 3.

Los mensajes nunca incluyen valores secretos. **VERIFICADO** (`env.validation.spec.ts`, `production-config.e2e-spec.ts`).

## 4. CORS

`FRONTEND_URL` es el único origen permitido.

| Parámetro | Valor |
|---|---|
| Métodos | `GET`, `POST`, `PATCH` (los únicos que usa la API) |
| Cabeceras | `Authorization`, `Content-Type`, `X-Correlation-Id` |
| Cabecera expuesta | `X-Correlation-Id` |
| Credenciales | No: la sesión viaja en `Authorization`, no en cookies |
| Caché de preflight | 10 min |

**VERIFICADO** (`app.e2e-spec.ts`, `production-config.e2e-spec.ts`). Las URLs de *preview* de Vercel no están permitidas. Si se necesitan, hay que decidir entre una lista explícita de orígenes y un entorno de *preview* con su propio backend (**REQUIERE DECISIÓN**).

## 5. Proxy inverso y rate limiting

- **Sin configuración** (`TRUST_PROXY_HOPS=0`), Express ignora `X-Forwarded-For` y `req.ip` es la IP del proxy de Render. Todos los usuarios comparten así el límite de login (5/min): un cliente podría bloquear el acceso de todos.
- **Con `TRUST_PROXY_HOPS=N`**, Express toma la IP del cliente saltando exactamente N proxies desde la derecha de `X-Forwarded-For`. Lo que un cliente anteponga en la cabecera queda a la izquierda y no se usa. Nunca se usa `true`.

**VERIFICADO:**

- Con 0, una cabecera falsificada no evade el límite.
- Con 1, dos clientes distintos detrás del mismo proxy tienen límites independientes y anteponer una IP falsa no evade el límite.

**PENDIENTE DE VALIDACIÓN REAL.** Render ubica la API detrás de su balanceador; la documentación de Render indica que la IP del cliente llega en `X-Forwarded-For`. El número de saltos debe **medirse** antes de fijarlo:

1. Desplegar con `TRUST_PROXY_HOPS=0`.
2. Agregar temporalmente un log de diagnóstico, o una ruta privada, que muestre `X-Forwarded-For` y `req.ip` para una solicitud de prueba propia.
3. Contar las entradas que añade la infraestructura: normalmente 1, o más si hay CDN.
4. Fijar `TRUST_PROXY_HOPS` a ese número, retirar el diagnóstico y repetir la prueba de 6 intentos de login desde dos redes distintas.

Si se pone delante otro proxy o CDN (p. ej. Cloudflare), el número cambia.

**Limitaciones del rate limit:**

- El contador está **en memoria**: con varias instancias, cada una cuenta por separado y el límite efectivo es N × 5. Se reinicia con cada despliegue.
- Para el MVP basta **una instancia**. Con varias, el almacenamiento debe ser compartido (Redis o PostgreSQL): **REQUIERE DECISIÓN**.
- **Límites recomendados** (REQUIERE DECISIÓN; no implementados salvo el login):
  - login 5/min por IP (implementado);
  - subidas 20/h por usuario (hoy: 2 simultáneas por usuario y 10 por proceso);
  - rutas internas sin límite por IP (token de servicio, operaciones idempotentes);
  - evaluación de alertas: la programa n8n, una vez por hora como máximo.

## 6. Health checks

| Ruta | Uso | Comportamiento |
|---|---|---|
| `GET /api/v1/health` | **Health check de Render** (liveness) | No consulta dependencias. Siempre 200 si el proceso responde |
| `GET /api/v1/health/ready` | Monitoreo externo (readiness) | `SELECT 1` con 3 s de límite: 200 `ready` o 503 `unavailable`. Sin host, errores ni credenciales |

No se usa readiness como health check de Render: un arranque en frío de Neon, que suspende el cómputo inactivo, haría reiniciar la instancia sin motivo. **VERIFICADO** (`app.e2e-spec.ts`; Neon: `/health/ready` → 200).

## 7. Swagger

Se publica en `/api/docs` solo si `NODE_ENV ≠ production`. En producción, `/api/docs` y `/api/docs-json` responden 404. **VERIFICADO** (`production-config.e2e-spec.ts`). Swagger no contiene tokens: los esquemas `bearer` y `service` no tienen valores de ejemplo.

## 8. Base de datos

- **BLOQUEANTE.** Crear `notihouse_app` y cambiar `DATABASE_URL` (procedimiento en backend-security-review.md, sección 6). Los SQL y la API con ese rol se comprobaron en PostgreSQL 18 local (Fase 4.2F.2); en Neon sigue sin ejecutarse. Hay que volver a aplicar `02-grant-app-privileges.sql` después de cada migración nueva.
- Pool: máximo 5 conexiones por instancia, `connectionTimeoutMillis` 10 s. Usar el host con **pooler** de Neon.
- El rol de aplicación tiene `statement_timeout` de 30 s e `idle_in_transaction_session_timeout` de 60 s.
- Las migraciones nunca se ejecutan desde Render.

## 9. Almacenamiento de archivos (BLOQUEANTE para la ingesta)

El disco de Render es efímero: el driver `local` está prohibido en producción y la API no arranca con él. Requisitos para elegir y configurar el proveedor S3-compatible:

1. Bucket **privado**: sin ACL públicas ni políticas de lectura anónima, con *Block Public Access* o equivalente.
2. Soporte de escritura condicional `If-None-Match: *` en `PutObject`, que es la política de no sobrescritura. **Verificarlo** subiendo dos veces la misma clave: la segunda debe responder 412. Si el proveedor no lo soporta, hay que decidir entre aceptar el riesgo (las claves son UUID nuevos) y añadir `HeadObject` previo.
3. Credenciales exclusivas del backend con permisos mínimos sobre el prefijo del bucket: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` (para la compensación) y `s3:ListBucket` (solo si se implementa la limpieza de huérfanos). Sin permisos de administración del bucket.
4. Cifrado en reposo y TLS (`STORAGE_S3_ENDPOINT` https).
5. Región próxima a Render y Neon (us-east). Las facturas no salen por URLs firmadas: todo pasa por la API.
6. Versionado y retención según la política de documentos: **REQUIERE DECISIÓN**.
7. Prueba de humo tras configurarlo:
   - subir un PDF;
   - descargarlo como propietario;
   - comprobar 404 para otro usuario;
   - comprobar el acceso del worker con su reclamación;
   - simular un fallo para verificar la compensación.

## 10. Secretos y rotación antes de publicar

1. Mover el clon fuera de OneDrive o excluir `backend/.env` y `backend/.local/` de la sincronización.
2. Rotar la contraseña del rol de Neon usado hasta ahora; desde la consola de Neon se reinicia la contraseña.
3. Generar un `JWT_SECRET` nuevo solo para producción. Esto invalida todas las sesiones.
4. Generar un `N8N_SERVICE_TOKEN` nuevo y cargarlo en n8n y en Render.
5. Rotar las contraseñas demo con `npm run db:demo:rotate-passwords`.
6. Cargar los secretos solo en el panel de Render (*Environment*), nunca en `render.yaml` ni en el repositorio.

## 11. Bloqueantes y checklist previa a la publicación

**Bloqueantes:**

- [ ] API con rol `notihouse_app` (no `neondb_owner`).
- [ ] Contraseñas demo individuales y rotadas; archivo de credenciales eliminado.
- [ ] Almacenamiento S3 privado configurado y probado.
- [ ] Secretos de producción nuevos (`JWT_SECRET`, `N8N_SERVICE_TOKEN`, contraseña de Neon).

**Checklist:**

- [ ] `FRONTEND_URL` con el dominio definitivo de Vercel.
- [ ] `TRUST_PROXY_HOPS` medido y probado (sección 5).
- [ ] Una sola instancia, o decisión tomada sobre el rate limit compartido.
- [ ] Build y start en Render con los comandos de la sección 1.
- [ ] Health check en `/api/v1/health`; `/api/v1/health/ready` → 200.
- [ ] Swagger: `/api/docs` → 404.
- [ ] CORS: preflight desde el frontend real → permitido; desde otro origen → sin `Access-Control-Allow-Origin`.
- [ ] Login de las cuatro cuentas, `/auth/me`, dashboard y bandeja.
- [ ] Ruta interna con un token incorrecto → 401; con un JWT de usuario → 401.
- [ ] Logs de Render revisados: sin tokens, contraseñas ni cadenas de conexión.
- [ ] Fase 4.2F.2 (concurrencia real) completada sobre un entorno descartable.
