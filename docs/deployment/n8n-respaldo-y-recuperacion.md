# n8n: persistencia, respaldo y recuperación

> Ningún paso de este documento imprime ni versiona secretos. Los respaldos con credenciales viven **fuera de Git y fuera de OneDrive** (p. ej. `C:\Users\<usuario>\notihouse-backups\`).

## 1. Qué hay y dónde

| Pieza | Dónde vive | En Git |
|---|---|---|
| Definición de los workflows (nodos, código, conexiones) | `n8n/workflows/*.json` (01, 02, 03, 04, 05, 05b, 06) | **Sí** |
| Generadores de 05, 05b y 06 | `n8n/tests/build-workflow-05*.mjs`, `build-workflow-06.mjs` (01–04 se editan directamente en su JSON) | **Sí** |
| Importador (resuelve credenciales por nombre y tipo) | `n8n/tools/import-workflow.mjs` | **Sí** |
| Contenedor | `infra/n8n/docker-compose.yml` (imagen fijada `2.46.6`, `restart: "no"`) | **Sí** |
| Credenciales, usuario propietario, ejecuciones, estado activo/inactivo | Volumen Docker **`notihouse_n8n_data`** → `/home/node/.n8n` (`database.sqlite`, `config`) | **No** |
| Clave de cifrado de credenciales | Archivo `config` del mismo volumen (la compose **no** define `N8N_ENCRYPTION_KEY`; n8n la generó en el primer arranque) | **No** |

El volumen es persistente (`name: notihouse_n8n_data`, declarado en la compose y montado en `notihouse-n8n`). `docker compose down` y recrear el contenedor **no** lo borran; `docker compose down -v`, `docker volume rm` o `docker system prune --volumes` **sí**. `n8n_data` pertenece a otro proyecto: no se monta ni se toca.

## 2. Qué pasa si…

| Situación | Resultado |
|---|---|
| Se recrea el contenedor con el mismo volumen | Todo sigue: credenciales, workflows y estado activo. La clave se lee de `config`. |
| Se pierde el volumen pero hay respaldo **completo** (volumen o `config` + `database.sqlite`) | Se restaura todo, incluidas credenciales. |
| Se pierde el volumen y solo se tienen los JSON del repo | Los **workflows se reconstruyen íntegros**; las **credenciales no**: hay que crearlas de nuevo (OAuth de Gmail con "Conectar" y reautorizar, token de servicio de la API con el valor guardado en Render/gestor de contraseñas). La nueva instalación genera otra clave de cifrado. |
| Se restaura `database.sqlite` **sin** el `config` original | Las credenciales quedan ilegibles (clave distinta). Siempre respaldar ambos juntos. |

Credenciales que existen (por nombre, no se versionan valores): `NotiHouse-Pal API (servicio)` (`httpHeaderAuth`) y `NotiHouse Gmail` (`googleOAuth2Api`, solo lectura). En modo *Testing* de Google el refresh token vence a los 7 días: reconectar antes de cada demostración.

## 3. Respaldo (con n8n detenido para una copia consistente)

```powershell
# 1) Detener (no borra nada)
docker stop notihouse-n8n

# 2) Copia cruda del volumen a una carpeta FUERA de OneDrive y de Git
$dest = "$env:USERPROFILE\notihouse-backups\n8n-$(Get-Date -Format yyyyMMdd-HHmm)"
New-Item -ItemType Directory -Force $dest | Out-Null
docker run --rm -v notihouse_n8n_data:/data:ro -v "${dest}:/backup" alpine tar czf /backup/notihouse_n8n_data.tgz -C /data .

# 3) Volver a encender
docker start notihouse-n8n
```

Con n8n encendido también sirve un export de **definiciones** (sin secretos descifrados; las credenciales solo aparecen como id y nombre):

```powershell
docker exec notihouse-n8n n8n export:workflow --all --pretty > "$dest\workflows-backup.json"
```

Tratar `notihouse_n8n_data.tgz` como secreto (contiene credenciales cifradas **y** la clave que las descifra). No subirlo a Git, ni a OneDrive, ni a un chat.

## 4. Recuperación

### 4.1 Con respaldo completo del volumen
```powershell
docker stop notihouse-n8n
docker run --rm -v notihouse_n8n_data:/data -v "<carpeta-respaldo>:/backup" alpine sh -c "cd /data && tar xzf /backup/notihouse_n8n_data.tgz"
docker compose -f infra/n8n/docker-compose.yml up -d
```
(Solo sobre un volumen **nuevo o vacío**; nunca encima del operativo sin respaldarlo antes.)

### 4.2 Desde cero, solo con el repositorio
1. `docker compose -f infra/n8n/docker-compose.yml up -d` y abrir `http://localhost:5678` (crear el propietario).
2. Crear las credenciales con **estos nombres y tipos exactos**: `NotiHouse-Pal API (servicio)` (Header Auth con el token de servicio) y `NotiHouse Gmail` (Google OAuth2, solo lectura).
3. Importar cada workflow resolviendo credenciales por nombre (importa **inactivo**):
   ```powershell
   foreach ($f in 01-prueba-de-conexion,02-procesamiento-documental,03-cierre-hitl,04-procesamiento-voz,06-mantenimiento-programado) {
     node n8n/tools/import-workflow.mjs "n8n/workflows/$f.json"
   }
   # Gmail: los datos del buzón NO están en Git; se pasan por variables locales
   $env:N8N_GMAIL_MAILBOX='<buzon>'; $env:N8N_GMAIL_SENDERS='<remitentes>'
   node n8n/tools/import-workflow.mjs n8n/workflows/05-recepcion-gmail.json
   $env:N8N_GMAIL_ALIAS='<buzon+etiqueta@dominio>'
   node n8n/tools/import-workflow.mjs n8n/workflows/05b-gmail-camila-alias.json
   ```
4. Ejecutar a mano el workflow 01 (conexión n8n ↔ API).
5. Valores de **entorno** que el JSON versionado deja en su valor seguro y hay que fijar a mano en el n8n operativo (ver §5).

## 5. Diferencias esperadas entre el repositorio y el n8n operativo (no son defectos)

Auditoría del 2026-11-11 (comparación nodo a nodo de tipo, parámetros, código, credenciales, reintentos, conexiones y ajustes):

| Workflow | Resultado |
|---|---|
| 01, 06 | Idénticos. |
| 02, 03, 04 | Idénticos salvo configuración de entorno: `AUTORIZAR_RECLAMACION` y `AUTOMATIZACION_PROGRAMADA` en `true` en el operativo (en el repo `false`) y disparo cada **10 s** (repo: 5 min). El 04 operativo además usa `saveDataSuccessExecution: none`. Para reconstruir un entorno de demostración se editan esas constantes en la copia importada (nunca en el repo). |
| 05 | El repo es **más nuevo** (incluye el disparador programado de la Etapa 7); el operativo conserva la versión anterior, inactiva. Los datos de buzón/remitentes del operativo son locales. No se modificó. |
| 05b | Idéntico salvo `BUZON_AUTORIZADO`, `ALIAS_ENTREGA` y `REMITENTES_AUTORIZADOS` (en el repo vacíos). |
| Solo en el operativo | `04b` (comprobación de audio, temporal) y el sondeo de Gemini de la Etapa 7 (archivado): no se versionan. |

Los ids de credenciales cambian por instalación; el importador los sustituye y el repo conserva marcadores.

## 6. Qué no hacer
- No exportar con `--decrypted` ni copiar `config` a ningún repositorio.
- No activar el 06 sin autorización (es global y afecta a todos los usuarios) ni el 05 (buzón de Daniel).
- No borrar `notihouse_n8n_data`; no montar `n8n_data`.
