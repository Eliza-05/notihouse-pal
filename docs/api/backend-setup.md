# Backend — Guía de configuración local

Guía para que cualquier integrante del equipo ejecute la API de NotiHouse-Pal (`backend/`) en su computador.

> **Estado (Fase 2):** el backend solo expone un endpoint de salud. **La base de datos (PostgreSQL/Neon) y n8n todavía no están conectados**, y no hay autenticación ni endpoints de negocio. Tampoco hay despliegue en Render.

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

## 5. Endpoints disponibles

Todos los endpoints funcionales usan el prefijo **`/api/v1`**.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/v1/health` | Liveness: confirma que el proceso de la API responde |

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
| `npm test` | Pruebas unitarias (Vitest, archivos `*.spec.ts`) |
| `npm run test:cov` | Pruebas unitarias con cobertura |
| `npm run test:e2e` | Pruebas end-to-end (archivos `test/*.e2e-spec.ts`) |

## 8. Estructura de `backend/src`

```text
src/
├── config/         # Validación de variables de entorno
├── health/         # Endpoint de salud (implementado)
├── auth/           # Autenticación y autorización (pendiente)
├── obligations/    # Obligaciones recurrentes (pendiente)
├── properties/     # Inmuebles (pendiente)
├── rentals/        # Cobros de arriendo (pendiente)
├── contracts/      # Contratos y vencimientos (pendiente)
├── cases/          # Casos, estados y HITL (pendiente)
├── integrations/   # Comunicación con n8n (pendiente)
├── audit/          # Trazabilidad (pendiente)
├── app.module.ts   # Módulo raíz
├── app.setup.ts    # Prefijo, CORS y Swagger (compartido con las pruebas e2e)
└── main.ts         # Punto de entrada
```

Los módulos marcados como pendientes existen solo como estructura y todavía no tienen controladores ni lógica.

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
