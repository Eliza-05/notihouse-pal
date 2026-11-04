# Preparación del backend para Render (Fase 4.2F.3)

Estado: **código preparado, no desplegado.** No se conectó GitHub a Render ni se creó ningún servicio. Los pasos están en [mvp-demo-setup.md](mvp-demo-setup.md); este documento recoge qué se comprobó y qué falta.

Alcance: demostración del MVP con **una sola instancia**, usada solo por el equipo.

**Clasificación:**

- **VERIFICADO:** comprobado con pruebas o ejecución.
- **PENDIENTE EN RENDER:** solo se puede comprobar con el servicio real.
- **DECISIÓN DEL EQUIPO:** depende de una elección del equipo.

## 1. Servicio

| Parámetro | Valor | Estado |
|---|---|---|
| Tipo | Web Service, runtime Node, rama `develop` | — |
| Root Directory | `backend` | VERIFICADO |
| Node | `NODE_VERSION=24`. Render documenta la lectura de `.node-version` solo en la raíz del repositorio, y este está en `backend/` | VERIFICADO con Node 24.22 en Linux |
| Build Command | `npm ci --include=dev && npm run build` | VERIFICADO en Linux limpio con `NODE_ENV=production`, sin `.env` |
| Start Command | `node dist/main` | VERIFICADO |
| Health Check Path | `/api/v1/health` | VERIFICADO |
| Región | Ohio (Neon está en `aws-us-east-2`; no se puede cambiar después) | DECISIÓN DEL EQUIPO |
| Plan | Free en el Blueprint. Sin `plan`, Render crea una instancia de pago | DECISIÓN DEL EQUIPO |
| Auto-Deploy | Desactivado | — |

- `--include=dev` es necesario: con `NODE_ENV=production` durante la compilación, `npm ci` omitiría el CLI de Nest y TypeScript.
- **`node dist/main`, no `npm run start:prod`.** Con `docker stop`, Node directo termina con `exit 0` y cierra el pool. Con npm como proceso principal termina con `exit 1` sin ese cierre, y envuelto en un shell no llega a terminar hasta el `SIGKILL`.
- Las migraciones no se ejecutan al arrancar y no deben añadirse al build ni al start.
- El Blueprint opcional es `infra/render/render.yaml`. No contiene secretos.

## 2. Arranque

| Comprobación | Resultado |
|---|---|
| `PORT` y `0.0.0.0` | VERIFICADO: responde en el puerto inyectado (`10000`) |
| Tiempo hasta `/health` → 200 | VERIFICADO: unos 2 s en contenedor local |
| `argon2` nativo en Linux | VERIFICADO: login real tras `npm ci` limpio |
| SIGTERM | VERIFICADO: cierre limpio con Node directo |
| Independencia del disco | VERIFICADO: el driver `s3` no usa disco persistente y `local` se rechaza |
| Swagger | VERIFICADO: `/api/docs` y `/api/docs-json` → 404 |

## 3. Variables de entorno

La tabla completa está en [mvp-demo-setup.md](mvp-demo-setup.md#4-variables-de-render).

**VERIFICADO:** en un contenedor de producción, la API se niega a arrancar, sin mostrar valores secretos, con:

- `STORAGE_DRIVER` ausente o `local`;
- bucket ausente, endpoint S3 `http`, o una sola clave S3;
- `JWT_SECRET` vacía o débil;
- `N8N_SERVICE_TOKEN` ausente o igual a `JWT_SECRET`;
- `DATABASE_URL` vacía o con comillas;
- `FRONTEND_URL` con barra final;
- `TRUST_PROXY_HOPS=true`;
- `PORT` inválido.

`FRONTEND_URL` es la única variable importante con un valor por defecto en producción (`http://localhost:5173`). Es intencional: permite desplegar antes de tener el dominio de Vercel sin abrir CORS.

## 4. CORS

`FRONTEND_URL` es el único origen permitido.

| Parámetro | Valor |
|---|---|
| Métodos | `GET`, `POST`, `PATCH` (no hay rutas `PUT` ni `DELETE`) |
| Cabeceras | `Authorization`, `Content-Type`, `X-Correlation-Id` |
| Cabecera expuesta | `X-Correlation-Id` |
| Credenciales | No: la sesión viaja en `Authorization` |
| Caché de preflight | 10 min |

- Las subidas multipart solo necesitan `Content-Type`. La idempotencia usa el campo `requestId`, sin cabecera propia. `X-Job-Id` y `X-Claim-Token` son solo de n8n, que no pasa por CORS.
- **Cómo rechaza a otros orígenes:** con un origen fijo, la API responde siempre `Access-Control-Allow-Origin: <FRONTEND_URL>`, también a los demás. Es el navegador el que bloquea por no coincidir. Por eso la comprobación correcta es que la cabecera no contenga el origen ajeno, no que falte.

**VERIFICADO** (`app.e2e-spec.ts`, `production-config.e2e-spec.ts`, `npm run smoke:api` en contenedor). Los dominios reales de Vercel siguen PENDIENTES.

## 5. Proxy inverso y rate limiting

- Con `TRUST_PROXY_HOPS=0`, Express ignora `X-Forwarded-For` y `req.ip` es la IP del proxy. Todos los usuarios compartirían el límite de login (5/min): cuatro personas entrando a la vez lo agotan casi por completo.
- Con `TRUST_PROXY_HOPS=N`, Express toma la IP saltando N proxies desde la derecha, de modo que lo que anteponga el cliente no se usa. Nunca se usa `true`.

**VERIFICADO** con un proxy simulado (`production-config.e2e-spec.ts`).

**PENDIENTE EN RENDER.** El número de saltos no se asume. Se mide desde fuera, sin cambiar código, con dos redes: [mvp-demo-setup.md, sección 6](mvp-demo-setup.md#6-verificar-el-backend-por-https).

**Aceptado para el MVP:** el contador está en memoria, se reinicia con cada despliegue y es por instancia. Con una sola instancia es suficiente. Siguen activos el límite de login, los límites de tamaño y las 2 subidas simultáneas por usuario y 10 por proceso.

## 6. Health checks

| Ruta | Uso | Comportamiento |
|---|---|---|
| `GET /api/v1/health` | Health check de Render | No consulta dependencias: un arranque en frío de Neon no reinicia la instancia |
| `GET /api/v1/health/ready` | Comprobación manual | `SELECT 1` con 3 s de límite: 200 `ready` o 503 `unavailable`, sin host, errores ni credenciales |

**VERIFICADO.** No revisa el almacenamiento; para eso está `npm run storage:check`.

## 7. Base de datos

**VERIFICADO en Neon, solo lectura:**

- conexión pooled (la de la API) y directa;
- PostgreSQL 18.6, 18 tablas, 3 migraciones;
- 4 cuentas;
- huella SHA-256 de todas las tablas idéntica antes y después del smoke test.

**Compatibilidad con el pooler:** el código no usa `SET` de sesión ni bloqueos asesores de sesión. Solo `pg_advisory_xact_lock`, que es de transacción.

**Rol `notihouse_app`:**

- **VERIFICADO en PostgreSQL 18 local:** los SQL `01`, `02`, `03`, el `LOGIN`, la API completa con ese rol (flujos PDF y voz sobre S3 local) y la reversión `99`.
- **PENDIENTE EN NEON:** no se ha creado. Requiere autorización.
- **Corrección de procedimiento:** Neon no admite contraseñas con hash, así que `\password` no sirve; se usa `ALTER ROLE … PASSWORD`. No se comprobó si la consola de Neon puede reiniciar la contraseña de un rol creado por SQL.
- **Sin comprobar todavía:** el acceso de un rol creado por SQL a través del pooler de Neon. El paso 5 del procedimiento lo prueba antes de tocar Render.

## 8. Almacenamiento

**Adaptador S3, VERIFICADO** contra MinIO con HTTPS, usando la API de producción en contenedor Linux:

- escritura y lectura en streaming, con contenido íntegro;
- `If-None-Match: *`, con 412 al sobrescribir;
- sin ACL ni URLs firmadas; acceso anónimo → 403;
- subida de PDF y audio, descarga del propietario y lectura del worker con reclamación;
- archivos disponibles tras **recrear el contenedor**, simulando el disco efímero de Render;
- logs sin credenciales;
- sin cambios de esquema.

**Compensación:** el borrado se probó contra MinIO. El caso de fallo de PostgreSQL tras guardar sigue cubierto en pruebas e2e con almacenamiento local y dobles.

**Ajuste realizado:** los checksums automáticos del SDK se limitan a las operaciones que los exigen. Con streams, el SDK añade trailers `aws-chunked` que no todos los proveedores documentan. La integridad se controla con el SHA-256 calculado al recibir.

**PENDIENTE:** el proveedor no está elegido ni probado, y la persistencia **no está verificada en Render**. Comparación y pasos: [mvp-demo-setup.md, sección 5](mvp-demo-setup.md#5-almacenamiento-de-pdf-y-audio).

## 9. Mejoras posteriores al MVP

No se implementan ahora; quedan documentadas:

- RLS, rate limit compartido, varias instancias y límites de subida por hora.
- Lista de varios orígenes CORS (para *previews* de Vercel).
- Limpieza de objetos huérfanos y análisis antimalware antes de aceptar PDF reales de terceros.
- Prueba de contención a través del pooler de Neon.
- Mover el clon fuera de OneDrive y rotar la contraseña de `neondb_owner`.

## 10. Checklist de publicación

**Antes de la URL pública (requieren aprobación):**

- [ ] `JWT_SECRET` y `N8N_SERVICE_TOKEN` nuevos, solo en Render.
- [ ] Contraseñas demo rotadas (recomendado; [riesgo](mvp-demo-setup.md#9-usuarios-demo)).
- [ ] API con `notihouse_app` (recomendado).
- [ ] Bucket privado con `npm run storage:check` correcto.

**Tras el primer despliegue:**

- [ ] `npm run smoke:api` contra la URL HTTPS.
- [ ] `TRUST_PROXY_HOPS` medido con dos redes.
- [ ] PDF y audio disponibles tras reiniciar en Render.
- [ ] Logs de Render sin tokens, contraseñas ni cadenas de conexión.
- [ ] `FRONTEND_URL` con el dominio definitivo y preflight real desde el navegador.
