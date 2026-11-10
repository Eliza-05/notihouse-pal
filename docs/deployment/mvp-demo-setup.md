# Puesta en marcha del backend para la demo del MVP

Guía para que un integrante del equipo publique el backend y lo deje listo para la demostración. Los comandos son de PowerShell y se ejecutan desde `backend/`.

**Estado:** el código está preparado, pero aún no hay nada desplegado. Render, el bucket, n8n y Vercel todavía no están configurados.

## 1. Qué servicios necesitamos

| Servicio | Para qué | Estado |
|---|---|---|
| Render (un Web Service) | API NestJS | Por crear |
| Neon | PostgreSQL | Listo: rama `production`, base `neondb`, 18 tablas, 3 migraciones |
| Bucket S3-compatible privado | Facturas PDF y notas de voz | Por crear (sección 5) |
| n8n en Docker, en un equipo del equipo | Workflows | Fase posterior (sección 7) |
| Vercel | Frontend React | Fase posterior (sección 8) |

## 2. Crear el Web Service en Render

**New → Web Service**, conectar `Eliza-05/notihouse-pal`:

| Campo | Valor |
|---|---|
| Language | Node |
| Branch | `develop` |
| Region | Ohio (no se puede cambiar después; es la más próxima a Neon, `aws-us-east-2`) |
| Root Directory | `backend` |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `node dist/main` |
| Instance Type | Free para empezar (ver abajo) |
| Health Check Path | `/api/v1/health` (en *Advanced*) |
| Auto-Deploy | Off |

- Usa `node dist/main`, no `npm run start:prod`: con npm, Node no termina limpiamente al recibir SIGTERM (comprobado en contenedor).
- No agregues PostgreSQL de Render, Redis ni más instancias.
- `infra/render/render.yaml` contiene lo mismo, por si prefieres crear un Blueprint con esa ruta.

**Free o de pago.** Free basta para la demo si se tienen en cuenta sus condiciones: se duerme tras 15 minutos sin tráfico, tarda cerca de un minuto en despertar, puede reiniciarse en cualquier momento y su disco es efímero. Tiene 750 horas al mes por workspace. Si no quieres depender del arranque en frío el día de la presentación, cambia a una instancia de pago; el precio vigente está en [render.com/pricing](https://render.com/pricing).

## 3. Neon

No hay que crear ninguna base ni ejecutar migraciones. Render nunca las ejecuta.

| Conexión | Variable | Quién la usa |
|---|---|---|
| Ejecución (host con `-pooler`) | `DATABASE_URL` | NestJS en Render |
| Administrativa (directa) | `DATABASE_URL_DIRECT` | Solo `npm run db:migrate` y `db:check`, en tu equipo. **No se carga en Render** |

### Activar el rol restringido `notihouse_app` (recomendado, unos 10 minutos)

Hoy la API se conecta como `neondb_owner`, dueño de todo el esquema. Con la URL pública es preferible limitar el daño de un error o de una credencial filtrada. El procedimiento y la API con ese rol se probaron en PostgreSQL 18 local; **en Neon aún no se ha ejecutado**.

1. En Neon, **SQL Editor**, ejecuta el contenido de estos archivos de `database/admin/`, en orden:
   1. `01-create-app-role.sql`
   2. `02-grant-app-privileges.sql`
   3. `03-verify-app-privileges.sql`: deben salir 18 filas, todas con `ok = true`.
2. Genera una contraseña en tu equipo:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
3. En el SQL Editor, ejecuta esto y luego borra la consulta del historial del editor:
   ```sql
   ALTER ROLE notihouse_app WITH LOGIN PASSWORD '<contraseña generada>';
   ```
   No uses `\password` de psql: Neon no admite contraseñas con hash.
4. Copia la cadena con pooling de **Connect** y cambia el usuario y la contraseña por los del rol nuevo.
5. Pruébala en tu equipo antes de tocar Render. Si la conexión por pooler falla con ese rol, detente aquí: Render sigue funcionando con la cadena anterior.
   ```powershell
   $env:DATABASE_URL='<cadena nueva>'; npm run build; node dist/main
   # En otra terminal:
   npm run smoke:api
   ```
6. Reemplaza `DATABASE_URL` en Render y guarda. Repite la verificación de la sección 6.

**Volver atrás:** restaura la `DATABASE_URL` anterior en Render y guarda; ningún paso toca datos. Después, si quieres, ejecuta `99-rollback-app-role.sql`. Guarda la cadena anterior en el gestor de contraseñas hasta confirmar el cambio.

Tras cualquier migración futura hay que repetir `02` y `03`.

## 4. Variables de Render

Pégalas en **Environment**, sin comillas. Genera `JWT_SECRET` y `N8N_SERVICE_TOKEN` nuevos, distintos entre sí y diferentes de los de tu `.env` local, que está en una carpeta sincronizada con OneDrive:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**Obligatorias.** Sin ellas, la API no arranca y el log indica qué falta, sin mostrar valores.

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `24` (no impide el arranque, pero fija la versión) |
| `DATABASE_URL` | Cadena de Neon con pooling |
| `JWT_SECRET` | ≥ 43 caracteres aleatorios |
| `N8N_SERVICE_TOKEN` | ≥ 43 caracteres aleatorios, distinto de `JWT_SECRET` |
| `STORAGE_DRIVER` | `s3` |
| `STORAGE_S3_BUCKET` | Nombre del bucket |
| `STORAGE_S3_REGION` | Región del proveedor (`auto` en R2) |

**Necesarias según el caso**

| Variable | Valor |
|---|---|
| `FRONTEND_URL` | Dominio de Vercel. Mientras no exista, omítela: queda `http://localhost:5173`. No hay comodín |
| `TRUST_PROXY_HOPS` | `1` para empezar. Mídelo en la sección 6: con `0`, todos los usuarios comparten el límite de 5 logins por minuto |
| `STORAGE_S3_ENDPOINT` | Obligatoria en proveedores distintos de AWS; debe ser `https` |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | Credenciales del bucket; van juntas |
| `STORAGE_S3_FORCE_PATH_STYLE` | `false`, salvo que el proveedor exija `true` |

**Opcionales** (con estos valores por defecto)

| Variable | Por defecto |
|---|---|
| `DUE_DATES_TIME_ZONE` | `America/Bogota` |
| `DUE_DATES_OBLIGATION_DAYS`, `DUE_DATES_RENT_CHARGE_DAYS`, `DUE_DATES_CONTRACT_DAYS`, `DUE_DATES_HITL_SOON_HOURS` | `7`, `7`, `30`, `6` |
| `STORAGE_MAX_PDF_BYTES`, `STORAGE_MAX_AUDIO_BYTES` | 10 MiB y 25 MiB |
| `STORAGE_UPLOAD_TMP_PATH` | Temporal del sistema (solo temporales de subida) |

`PORT` la pone Render. El backend no tiene variables de nivel de log ni de tamaño del pool: el pool está fijo en 5 conexiones. Las variables `CONCURRENCY_*` son solo de pruebas.

## 5. Almacenamiento de PDF y audio

El disco de Render es efímero: un archivo guardado allí desaparece al reiniciar. Por eso la API **no arranca** en producción con `STORAGE_DRIVER=local`.

| | Bucket S3-compatible privado (recomendado) | Disco persistente de Render |
|---|---|---|
| Cambios de código | Ninguno: el adaptador ya existe | Hay que permitir el driver local en producción y cambiar la validación y sus pruebas |
| Plan de Render | Funciona en Free | Exige instancia de pago, además del costo del disco |
| Despliegues | Sin impacto | Sin cero-downtime: el servicio se detiene unos segundos |
| Si se recrea el servicio | Los archivos siguen en el bucket | Los archivos dependen de ese disco |
| Costo | Según proveedor. R2 incluye 10 GB/mes, sin costo de salida; confirma al activarlo si te pide método de pago | Consultar [render.com/pricing](https://render.com/pricing) |

Pasos con cualquier proveedor compatible. Entre paréntesis, los datos de Cloudflare R2, que es solo un ejemplo: **el proveedor lo elige el equipo**.

1. Crea un bucket privado, sin acceso público (R2 los crea privados; no actives `r2.dev` ni dominios públicos).
2. Crea credenciales limitadas a ese bucket: lectura, escritura y borrado de objetos (R2: token *Object Read & Write* restringido al bucket). En AWS: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` y `s3:ListBucket`; sin este último, un objeto inexistente responde 403 en lugar de 404.
3. Comprueba el bucket desde tu equipo. Las variables viven solo en esa terminal:
   ```powershell
   $env:STORAGE_S3_BUCKET='<bucket>'
   $env:STORAGE_S3_REGION='auto'
   $env:STORAGE_S3_ENDPOINT='https://<ACCOUNT_ID>.r2.cloudflarestorage.com'
   $env:STORAGE_S3_ACCESS_KEY_ID='<clave>'
   $env:STORAGE_S3_SECRET_ACCESS_KEY='<secreto>'
   npm run storage:check
   ```
   El script escribe, comprueba que `If-None-Match` impide sobrescribir (412), lee, confirma que no hay acceso anónimo y borra su objeto de prueba. Si el proveedor no respeta `If-None-Match`, el script falla: elige otro proveedor o documenta el riesgo (las claves son UUID nuevos, así que una colisión es muy improbable).
4. Carga las variables `STORAGE_*` en Render.

Cuando la configuración esté hecha, comprueba la persistencia real en Render: sube un PDF y un audio, pulsa **Manual Deploy → Restart service** y vuelve a descargarlos (sección 10).

> **Lo comprobado hasta ahora:** el adaptador, contra MinIO local sobre HTTPS y con la API en contenedor Linux. Los archivos siguieron disponibles tras recrear el contenedor. **No se ha probado todavía con el proveedor elegido ni en Render.**

## 6. Verificar el backend por HTTPS

Tras el despliegue, con la URL de Render:

```powershell
$env:SMOKE_API_URL='https://<servicio>.onrender.com'
$env:SMOKE_ORIGIN='<valor de FRONTEND_URL>'
# Solo si rotaste las contraseñas demo:
$env:SMOKE_CREDENTIALS_FILE='<ruta del archivo fuera de OneDrive>'
npm run build
npm run smoke:api
```

Solo hace lecturas. Comprueba salud, Neon, las cuatro cuentas y sus listados, Swagger deshabilitado, CORS y el rechazo de JWT y tokens incorrectos. Consume 4 logins: espera un minuto antes de repetirlo.

Si Render estaba dormido, la primera respuesta puede tardar cerca de un minuto. Un 503 en `/health/ready` puede ser un arranque en frío de Neon: reintenta.

**Medir `TRUST_PROXY_HOPS`** (con el valor `1` ya cargado). Usa un correo inexistente, porque solo cuenta intentos. Necesitas dos redes, por ejemplo Wi-Fi y datos móviles:

```powershell
$body = '{"email":"nadie@notihouse.test","password":"prueba-de-limite"}'
$url = "$env:SMOKE_API_URL/api/v1/auth/login"
function Try-Login($headers = @{}) {
  try { (Invoke-WebRequest $url -Method Post -ContentType 'application/json' -Body $body -Headers $headers -UseBasicParsing).StatusCode }
  catch { $_.Exception.Response.StatusCode.value__ }
}
```

| Paso, dentro del mismo minuto | Comando | Esperado | Si no ocurre |
|---|---|---|---|
| Red A: seis intentos | `1..6 \| ForEach-Object { Try-Login }` | Cinco 401 y un 429 | — |
| Red B: un intento | `Try-Login` | 401 | Si da 429, todos comparten límite: sube a `2` y repite |
| Red A: cabecera falsa | `Try-Login @{'X-Forwarded-For'='203.0.113.9'}` | 429 | Si da 401, se puede falsificar la IP: baja el valor y repite |

Si repites la medición, espera un minuto. Un cambio de CDN o proxy delante de Render obliga a medir otra vez.

## 7. Conectar n8n local (fase posterior)

n8n solo hace solicitudes **salientes** a Render, así que no hay que publicar el puerto del contenedor. n8n nunca recibe credenciales de PostgreSQL.

1. Crea en n8n una credencial *Header Auth*: `Authorization: Bearer <N8N_SERVICE_TOKEN>`.
2. Usa como base `https://<servicio>.onrender.com/api/v1`.
3. Configura en los nodos HTTP un tiempo de espera de 90 s o más, por el arranque en frío de Render Free.
4. Usa **un solo** workflow programado para `POST /internal/alerts/evaluate`, como máximo una vez por hora.

El orden de las llamadas y los códigos de respuesta están en [workflow-integration.md](../api/workflow-integration.md#contrato-para-n8n-contra-render-fase-42f3). Si el equipo con n8n está apagado, los trabajos quedan pendientes; una reclamación vencida se puede volver a reclamar mientras queden intentos.

## 8. Permitir el frontend de Vercel (fase posterior)

1. Copia el dominio de producción de Vercel y carga en Render `FRONTEND_URL=https://<dominio>`: exacto, sin ruta ni barra final. Con un valor mal formado, la API no arranca.
2. En Vercel, apunta el frontend a `https://<servicio>.onrender.com/api/v1`.
3. Repite `npm run smoke:api` con `SMOKE_ORIGIN` igual a ese dominio.

Solo se admite un origen, así que las URL de *preview* de Vercel y `localhost` dejan de funcionar contra Render mientras esté cargado el dominio de producción.

La política ya cubre lo que usa el frontend: `GET`, `POST`, `PATCH`, `Authorization`, `Content-Type` (incluye `multipart/form-data`), `X-Correlation-Id` como cabecera admitida y expuesta. La idempotencia viaja en el campo `requestId` del cuerpo, no en una cabecera. El frontend se autentica con la cabecera `Authorization`, sin cookies.

CORS es una barrera del navegador: el servidor responde siempre con el origen configurado, y es el navegador el que bloquea a los demás. No sustituye a la autenticación, ni afecta a `curl` o n8n.

## 9. Usuarios demo

Laura Martínez, Andrés Gómez, Camila Torres y Daniel Rojas ya existen en Neon; sus correos están en `backend/src/database/seed/demo-data.ts`. Las contraseñas **no se publican**: se comparten por un gestor de contraseñas. Las sesiones duran 30 minutos, así que inicia sesión justo antes de presentar.

**Riesgo.** Hoy las cuatro cuentas comparten una contraseña temporal débil que además apareció en salidas locales. Con la API pública, quien la conozca o la adivine puede ver y modificar los datos ficticios de las cuatro cuentas. El límite de 5 intentos por minuto dificulta adivinarla, pero no protege si ya se conoce.

**Alternativa recomendada.** Antes de publicar la URL, genera una contraseña fuerte por cuenta con `npm run db:demo:rotate-passwords`, guárdalas en el gestor y sigue entrando igual. Hace falta aprobarlo porque escribe en Neon; el procedimiento está en [backend-security-review.md](../security/backend-security-review.md#42-rotación-de-las-contraseñas-demo-preparada-no-ejecutada). Después borra `backend/.local/demo-credentials.txt`.

## 10. Comprobar los flujos de la demo

**Sin n8n** (usa archivos ficticios, porque estas cargas sí escriben en Neon):

1. Con un JWT de Laura, sube una factura:
   ```powershell
   curl.exe -X POST "$env:SMOKE_API_URL/api/v1/ingestions/documents" -H "Authorization: Bearer <JWT>" -F "file=@factura-ficticia.pdf;type=application/pdf"
   ```
   Espera `201`, con `processing: "pending"`.
2. Sube una nota de voz a `/ingestions/voice` de la misma manera, con `type=audio/wav` o el formato que corresponda.
3. Reinicia el servicio en Render y descarga ambos con `GET /api/v1/documents/<id>/content`. Si responden `200`, la persistencia queda **verificada en Render**.

**Con n8n:** sigue los flujos PDF y voz de [workflow-integration.md](../api/workflow-integration.md#contrato-para-n8n-contra-render-fase-42f3).

**Lista antes de presentar** (empieza 10 minutos antes):

- [ ] Backend despierto: `GET /api/v1/health` → 200.
- [ ] Neon accesible: `GET /api/v1/health/ready` → 200.
- [ ] `npm run smoke:api` correcto, un minuto antes de que el equipo inicie sesión.
- [ ] Almacenamiento: `npm run storage:check` correcto.
- [ ] n8n ejecutándose y workflows activos.
- [ ] Frontend accesible e inicio de sesión desde el navegador.
- [ ] Datos demo listos. Neon empieza sin alertas ni casos: ejecuta `POST /internal/alerts/evaluate` para generar las alertas de ese día. Las revisiones HITL vencen a las 24 horas, así que crea los casos de la demo el mismo día.

## 11. Errores frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| El deploy falla con `Configuración de entorno inválida` | Variable ausente o mal formada | El log dice cuál. Corrígela en *Environment* |
| `DATABASE_URL no es una URL válida` | Se pegó con comillas | Pégala sin comillas |
| `/health` responde, `/health/ready` da 503 | Neon despertando, o `DATABASE_URL` incorrecta | Reintenta; si persiste, revisa la cadena y que el rol tenga LOGIN |
| La primera solicitud tarda cerca de un minuto | Render Free dormido | Normal. Abre `/health` antes de presentar |
| Login → 429 | Límite de 5 por minuto, compartido si `TRUST_PROXY_HOPS=0` | Espera un minuto y mide el valor (sección 6) |
| Login → 401 con la contraseña correcta | Se rotó la contraseña | Usa la del gestor |
| Sesión → 401 de repente | JWT vencido (30 min), o cambió `JWT_SECRET` o la contraseña | Inicia sesión otra vez |
| Error de CORS en el navegador | `FRONTEND_URL` distinta del dominio real | Corrige el origen exacto, sin barra final |
| Subida o descarga → 503 | Bucket no disponible o credenciales incorrectas | Ejecuta `npm run storage:check` con esas variables |
| n8n → 401 | Token distinto al de Render | Compara la credencial con `N8N_SERVICE_TOKEN` |
| n8n → 409 | Reclamación vencida o reemplazada, o `complete` contradictorio | No lo ignores: vuelve a reclamar; no reenvíes un resultado distinto |

## 12. Reiniciar o recuperar el servicio

| Situación | Acción |
|---|---|
| Comportamiento anómalo | **Manual Deploy → Restart service**. Sesiones y archivos se conservan; los contadores de login se reinician |
| Nuevo código en `develop` | **Manual Deploy → Deploy latest commit** (Auto-Deploy está desactivado) |
| El último despliegue falló | **Events → Rollback** a la versión anterior |
| Build con errores raros | **Manual Deploy → Clear build cache & deploy** |
| Secreto expuesto | Genera otro y reemplázalo en *Environment*. Cambiar `JWT_SECRET` cierra todas las sesiones; al cambiar `N8N_SERVICE_TOKEN`, actualiza también n8n |

Un reinicio a mitad de una operación no deja datos a medias: PostgreSQL revierte la transacción abierta. Un trabajo reclamado por n8n se recupera al vencer su arrendamiento.
