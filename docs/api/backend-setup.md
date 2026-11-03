# Backend — Guía de configuración local

Guía para que cualquier integrante del equipo ejecute la API de NotiHouse-Pal (`backend/`) en su computador.

> **Estado (Fase 4.2D):** el backend tiene salud, **autenticación** (login, JWT, `GET /auth/me`, rutas privadas por defecto), **persistencia en Neon** (Drizzle, migraciones `0000` y `0001`, cuatro usuarios demo) y la **API de negocio de inmuebles, obligaciones, períodos y confirmación manual**, y de **arriendos, cobros y contratos** ([business-api.md](business-api.md)), y la **infraestructura para n8n**: casos, propuestas, HITL y cola de trabajos con token de servicio ([workflow-integration.md](workflow-integration.md)), y la **ingesta de PDF y notas de voz** con almacenamiento privado ([ingestion-api.md](ingestion-api.md)). **Todavía no hay workflows de n8n ni servicios externos conectados** (OCR, STT, IA, Gmail OAuth), ni despliegue en Render. Diseño: [base de datos](../architecture/database-design.md) y [autenticación](../architecture/authentication.md).

## 1. Requisitos

| Herramienta | Versión |
|---|---|
| Node.js | `^22.22.3`, `^24.15.0` o `>=26` (exigido por el generador `@nestjs/schematics` 12). Se recomienda la LTS 24.x. |
| npm | La incluida con Node.js (probado con 11.19) |
| Git | Cualquier versión reciente |

Comprueba las versiones:

```bash
node -v
npm -v
```

## 2. Instalación

```bash
git clone https://github.com/Eliza-05/notihouse-pal.git
cd notihouse-pal
git checkout develop
cd backend
npm ci
```

`npm ci` instala exactamente las versiones de `package-lock.json`. Usa `npm install` solo si vas a agregar o actualizar dependencias.

## 3. Variables de entorno

Copia la plantilla y ajusta los valores si lo necesitas:

```bash
cp .env.example .env        # macOS / Linux / Git Bash
copy .env.example .env      # Windows (cmd)
```

| Variable | Obligatoria | Valor por defecto | Descripción |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development`, `test` o `production`. En `production` Swagger se deshabilita. |
| `PORT` | No | `3000` | Puerto HTTP. Debe ser un entero entre 1 y 65535. |
| `FRONTEND_URL` | No | `http://localhost:5173` | Origen permitido por CORS (servidor de Vite). Debe ser un origen `http(s)` sin ruta. |
| `DATABASE_URL` | Sí (salvo `NODE_ENV=test`) | — | Cadena de Neon **con** Connection Pooling. La usa la API. |
| `DATABASE_URL_DIRECT` | Solo para migrar | — | Cadena de Neon **sin** Connection Pooling. La usan `db:migrate`, `db:check` y `db:seed:demo`. |
| `JWT_SECRET` | Sí (salvo `NODE_ENV=test`) | — | Secreto HS256 de los JWT: mínimo 43 caracteres aleatorios (32 bytes). Se rechazan valores de ejemplo o de baja entropía. Genéralo localmente con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Cada entorno tiene el suyo y nunca se comparte. |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_PATH`, `STORAGE_UPLOAD_TMP_PATH`, `STORAGE_MAX_PDF_BYTES`, `STORAGE_MAX_AUDIO_BYTES`, `STORAGE_S3_*` | `STORAGE_DRIVER=s3` obligatorio en `production` | `local`, `backend/.local/storage`, 10 MiB / 25 MiB | Almacenamiento privado de archivos. El driver local se rechaza en producción (disco efímero de Render). Ver [ingestion-api.md](ingestion-api.md#3-variables-de-entorno). |
| `TRUST_PROXY_HOPS` | No | `0` | Proxies inversos de confianza (0 a 3). Con 0 se ignora `X-Forwarded-For`. Ver [render-readiness.md](../deployment/render-readiness.md). |
| `DUE_DATES_TIME_ZONE`, `DUE_DATES_OBLIGATION_DAYS`, `DUE_DATES_RENT_CHARGE_DAYS`, `DUE_DATES_CONTRACT_DAYS`, `DUE_DATES_HITL_SOON_HOURS` | No | `America/Bogota`, 7, 7, 30, 6 | Zona horaria y umbrales de aviso del motor de vencimientos (parámetros operativos del MVP). Ver [alerts-and-dashboard.md](alerts-and-dashboard.md#15-umbrales-iniciales-parámetros-operativos-del-mvp). |
| `N8N_SERVICE_TOKEN` | Solo en `production` | — | Token Bearer del servicio de automatización para las rutas `/api/v1/internal/*`. Mismos requisitos que `JWT_SECRET` y distinto de él. Sin él, las rutas internas rechazan toda solicitud. Ver [workflow-integration.md](workflow-integration.md#2-autenticación-del-servicio). |

Las dos cadenas se obtienen en Neon > *Connect* (proyecto `notihouse-pal`, rama `production`, base `neondb`), activando o desactivando *Connection pooling*. Pídelas a la persona responsable del proyecto en Neon por un canal privado; **nunca** las compartas en el repositorio, issues o chats del equipo.

- El archivo `backend/.env` está excluido de Git. **Nunca lo subas al repositorio.**
- Las variables del sistema tienen prioridad sobre las del archivo `.env`.
- Si alguna variable es inválida, la aplicación **no arranca** y muestra un mensaje que lo explica. Por ejemplo:

  ```text
  Error: Configuración de entorno inválida:
  - PORT debe ser un entero entre 1 y 65535 (recibido: "abc")
  ```

## 4. Ejecución local

Ejecuta los comandos desde `backend/`:

| Comando | Uso |
|---|---|
| `npm run start:dev` | Desarrollo, con recarga automática |
| `npm run start` | Ejecución simple sin recarga |
| `npm run start:debug` | Desarrollo con depurador |
| `npm run build` | Compila a `dist/` |
| `npm run start:prod` | Ejecuta el código compilado (`node dist/main`) |

La API escucha en `0.0.0.0:<PORT>`, por lo que es accesible en `http://localhost:3000`.

### Base de datos

| Comando | Qué hace |
|---|---|
| `npm run db:check` | Compila y ejecuta `SELECT 1` por ambas conexiones en modo **solo lectura**; muestra base, rol, versión, tablas y migraciones aplicadas, sin credenciales |
| `npm run db:check:migrations` | Verifica la consistencia del historial de migraciones (`drizzle-kit check`, sin conexión) |
| `npm run db:demo:update-identities` | Solo para bases creadas con versiones anteriores del seed: renombra las cuentas demo `*@notihouse.test` a las identidades actuales, conservando sus UUID y datos. La contraseña se pasa en la variable temporal `DEMO_ACCOUNTS_PASSWORD`. Ver [authentication.md](../architecture/authentication.md#7-usuarios-de-demostración) |
| `npm run db:seed:demo` | Crea los cuatro usuarios demo y sus datos ficticios. Solo con `NODE_ENV=development` en un equipo local. Es idempotente y guarda las contraseñas solo en `backend/.local/demo-credentials.txt` (ignorado por Git). Ver [authentication.md](../architecture/authentication.md#7-usuarios-de-demostración) |
| `npm run db:generate -- --name <nombre>` | Genera una nueva migración SQL a partir de `src/database/schema/` en `database/migrations/` (sin conexión) |
| `npm run db:migrate` | **Aplica** las migraciones pendientes a Neon con `DATABASE_URL_DIRECT`. Ver precauciones en el documento de diseño antes de ejecutarlo |

La API **no** ejecuta migraciones al arrancar. El pool de PostgreSQL se conecta de forma diferida: la API arranca aunque Neon esté suspendido, y `GET /api/v1/health` no consulta la base de datos. No se configuró `drizzle-kit studio`, porque daría acceso de escritura directo a la única rama de Neon.

## 5. Endpoints disponibles

Todos los endpoints funcionales usan el prefijo **`/api/v1`**.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/health` | Liveness: confirma que el proceso de la API responde. **Público** |
| `GET` | `/api/v1/health/ready` | Readiness: `SELECT 1` a PostgreSQL con 3 s de límite; 503 si no responde. Sin detalles internos. **Público** |
| `POST` | `/api/v1/auth/login` | Inicio de sesión con correo y contraseña. Devuelve un JWT de 30 minutos. **Público**, máximo 5 intentos por minuto por IP |
| `GET` | `/api/v1/auth/me` | Usuario autenticado. Requiere `Authorization: Bearer <token>` |
| `GET` `POST` | `/api/v1/properties` | Listar o crear inmuebles propios |
| `GET` `PATCH` | `/api/v1/properties/:id` | Consultar o editar un inmueble propio |
| `GET` `POST` | `/api/v1/obligations` | Listar o crear obligaciones propias |
| `GET` `PATCH` | `/api/v1/obligations/:id` | Consultar o editar la definición de una obligación |
| `GET` `POST` | `/api/v1/obligations/:id/occurrences` | Listar o crear períodos |
| `GET` `PATCH` | `/api/v1/obligations/:id/occurrences/:occurrenceId` | Consultar o editar un período pendiente |
| `POST` | `/api/v1/obligations/:id/occurrences/:occurrenceId/confirm` | Confirmación humana de pago o atención |
| `GET` | `/api/v1/dashboard/summary` | Indicadores agregados del usuario ([alerts-and-dashboard.md](alerts-and-dashboard.md#4-dashboard)) |
| `GET` | `/api/v1/attention` | Bandeja unificada de atención |
| `GET` | `/api/v1/alerts`, `/api/v1/alerts/:id` | Alertas internas propias |
| `POST` | `/api/v1/alerts/:id/read`, `/api/v1/alerts/:id/dismiss` | Marcar como leída o descartar |
| `POST` | `/api/v1/cases/:caseId/proposals/:proposalId/apply` | Aplicar una propuesta aprobada ([proposal-application.md](proposal-application.md)) |

Las rutas de negocio requieren JWT y solo operan sobre los datos del usuario autenticado. Formatos, reglas, paginación y errores: [business-api.md](business-api.md).

Todas las rutas son **privadas por defecto**: solo las marcadas con `@Public()` aceptan peticiones sin token. No existe registro público. Detalle en [authentication.md](../architecture/authentication.md).

Ejemplo de respuesta (HTTP 200):

```json
{
  "status": "ok",
  "service": "notihouse-pal-api",
  "timestamp": "2026-10-24T19:00:00.000Z"
}
```

`timestamp` se genera en cada solicitud, en ISO 8601 (UTC). El endpoint **no** verifica la base de datos, n8n ni servicios externos.

```bash
curl http://localhost:3000/api/v1/health
```

## 6. Documentación Swagger

Con `NODE_ENV` distinto de `production`:

- Interfaz: <http://localhost:3000/api/docs>
- Especificación OpenAPI (JSON): <http://localhost:3000/api/docs-json>

En `production` Swagger está deshabilitado y estas rutas responden 404.

## 7. Calidad y pruebas

| Comando | Qué hace |
|---|---|
| `npm run lint` | Análisis estático con oxlint |
| `npm run format` | Formatea `src/` y `test/` con Prettier |
| `npm test` | Pruebas unitarias (Vitest, archivos `*.spec.ts`). Incluye las pruebas de integridad del esquema y del seed sobre PostgreSQL en memoria (PGlite): no requieren Neon ni red |
| `npm run test:cov` | Pruebas unitarias con cobertura |
| `npm run test:e2e` | Pruebas end-to-end (archivos `test/*.e2e-spec.ts`) |

## 8. Estructura de `backend/src`

```text
src/
├── common/         # Paginación, validadores (fecha, dinero), correlation_id, filtro de errores de BD
├── config/         # Validación de variables de entorno
├── database/       # Drizzle + pg: módulo global, esquema, script db-check
│   ├── schema/     # Definición de tablas (fuente de las migraciones)
│   └── scripts/    # db-check.ts
├── health/         # Endpoint de salud (implementado)
├── auth/           # Login, JWT, guard global, @Public(), @CurrentUser() (implementado)
├── obligations/    # Obligaciones, períodos y confirmación manual (implementado)
├── properties/     # Inmuebles (implementado)
├── rentals/        # Arriendos, cobros y confirmación de recepción
├── contracts/      # Metadatos de contratos y vencimientos
├── cases/          # Casos, propuestas y revisiones HITL
├── integrations/   # Cola de trabajos para n8n (rutas internas)
├── ingestion/      # Carga de PDF y voz, documentos privados, acceso del worker, contrato Gmail
├── storage/        # FileStorage: adaptadores local (desarrollo) y S3-compatible (producción)
├── audit/          # AuditService: eventos transaccionales en audit_events (implementado)
├── app.module.ts   # Módulo raíz
├── app.setup.ts    # Prefijo, CORS y Swagger (compartido con las pruebas e2e)
└── main.ts         # Punto de entrada
```

Los módulos marcados como pendientes existen solo como estructura y todavía no tienen controladores ni lógica.

Fuera de `src/`: `backend/drizzle.config.ts` (configuración de Drizzle Kit) y `database/migrations/` en la raíz del monorepositorio (única ubicación de las migraciones).

## 9. Seguridad de dependencias

### CVE-2026-113872 — Multer (corregida, Fase 2.1)

| Campo | Detalle |
|---|---|
| Aviso | [GHSA-q7qp-rjg7-q26m](https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m). Severidad alta (CVSS 7.5): DoS por un `fileFilter` asíncrono pendiente cuando la solicitud se interrumpe |
| Versión vulnerable | `multer@2.4.0` (rango afectado `>=2.0.0 <2.5.0`), fijada de forma exacta por `@nestjs/platform-express@12.2.0` |
| Versión instalada | `multer@2.5.0` |
| Solución | `overrides` de npm en `backend/package.json`, limitado a `@nestjs/platform-express` |

```json
"overrides": {
  "@nestjs/platform-express": { "multer": "2.5.0" }
}
```

**Justificación:** a la fecha, `@nestjs/platform-express@12.2.0` es la versión más reciente publicada y sigue dependiendo exactamente de `multer@2.4.0`, por lo que no hay actualización oficial disponible. `multer@2.5.0` es un parche dentro de la misma versión principal, con las mismas dependencias y el mismo requisito de Node. En `package-lock.json` solo cambió la entrada de `multer`. Bajar NestJS a la versión 11 (lo que propone `npm audit fix --force`) no es aceptable.

**Verificación:**
- Tras `npm ci`, `npm ls multer` muestra `multer@2.5.0 overridden`.
- `npm audit --omit=dev` reporta `found 0 vulnerabilities`.
- Build, lint, 15 pruebas unitarias y 4 e2e correctos; `GET /api/v1/health` responde 200 y Swagger 200.

**Cuándo retirar el override:** cuando una versión de `@nestjs/platform-express` 12.x dependa de `multer >=2.5.0`. En ese momento, actualiza los paquetes `@nestjs/*`, elimina el bloque `overrides`, ejecuta `npm install` y confirma con `npm ls multer` y `npm audit --omit=dev` que no se vuelve a una versión vulnerable.

### esbuild en `@esbuild-kit/core-utils` (Fase 3, solo desarrollo)

Al instalar `drizzle-kit@0.31.11`, `npm audit` reportó 4 hallazgos moderados ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99): el servidor de desarrollo de esbuild permite que cualquier sitio web lea sus respuestas). Llegaban por la cadena `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild@0.18.20`.

- Es una dependencia de desarrollo; no llega a producción (`npm audit --omit=dev` daba 0).
- El código de drizzle-kit **no carga** `@esbuild-kit`. Usa su propio `esbuild@0.25.12` (ya corregido) y `tsx`.
- La corrección que propone `npm audit fix --force` (bajar a `drizzle-kit@0.18.1`) no es aceptable.
- **Solución:** un override limitado que alinea ese `esbuild` sin uso con la versión que drizzle-kit ya trae:

  ```json
  "@esbuild-kit/core-utils": { "esbuild": "0.25.12" }
  ```

  En `package-lock.json` solo cambió esa rama. Después de `npm ci`, `npm audit` y `npm audit --omit=dev` reportan 0 vulnerabilidades, y `db:generate` y `db:check:migrations` siguen funcionando.
- **Cuándo retirarlo:** cuando una versión estable de drizzle-kit deje de depender de `@esbuild-kit/esm-loader`. Compruébalo con `npm ls @esbuild-kit/core-utils` después de actualizar.

### Eliminación de NestJS Mau (Fase 2.2)

El generador de NestJS incluía la devDependency `@nestjs/mau@0.2.9` y el script `"deploy": "nest deploy"`, que sirven para desplegar en NestJS Mau. **El despliegue seleccionado es Render**, así que se eliminaron ambos con `npm uninstall @nestjs/mau` y `npm pkg delete scripts.deploy`.

- Mau no intervenía en la compilación, la ejecución ni las pruebas: el CLI solo lo carga desde el comando `deploy`, y de forma opcional.
- Mau fijaba versiones vulnerables de `undici@6.20.1` y `tmp@0.0.33` (a través de `inquirer@8.2.6` → `external-editor`). Eran los 5 hallazgos de desarrollo (2 altos, 1 moderado, 2 bajos) que reportaba `npm audit`.
- Se retiraron 50 paquetes del lockfile y ninguna otra versión cambió. El override de Multer se mantiene.
- `nest deploy` sigue apareciendo en la ayuda del CLI porque es un comando incorporado de `@nestjs/cli`. No debe usarse en este proyecto.

**Resultado tras `npm ci`:** `npm audit` y `npm audit --omit=dev` reportan `found 0 vulnerabilities`. Build, lint, 15 pruebas unitarias y 4 e2e correctos; `GET /api/v1/health` responde 200 y Swagger 200.

## 10. Problemas frecuentes

- **`EADDRINUSE`**: el puerto está ocupado. Cambia `PORT` en `.env` o detén el otro proceso.
- **Error de CORS desde el frontend**: verifica que `FRONTEND_URL` coincida exactamente con el origen del navegador (protocolo, host y puerto, sin `/` final).
- **`EBADENGINE` al instalar**: actualiza Node.js a una versión compatible (sección 1).
