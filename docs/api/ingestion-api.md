# API de ingesta: facturas PDF, notas de voz y recepción por Gmail

El backend recibe archivos, los guarda de forma privada, registra sus metadatos y crea el caso y el trabajo que los workflows de n8n procesarán más adelante.

> **Qué NO hace esta fase:**
> - No extrae texto de PDF, no hace OCR ni transcribe audio.
> - No llama a modelos de IA ni a Gmail, y no ejecuta workflows: eso lo hace n8n.
> - Cargar un archivo **no** crea obligaciones ni modifica pagos, cobros o contratos.
> - "Recibido" significa almacenado y encolado, no procesado.

## 1. Arquitectura de ingesta

```
Usuario ─JWT─▶ POST /ingestions/documents | /ingestions/voice
                 │ 1. guard JWT (antes de leer el cuerpo)
                 │ 2. multipart en streaming → temporal privado (SHA-256, tamaño, firma)
                 │ 3. validación del archivo y de las referencias propias
                 │ 4. objeto privado en FileStorage (local | s3)
                 │ 5. PostgreSQL, en UNA transacción: caso + documento + trabajo + auditoría
                 ▼
          workflow_jobs (document.process | voice.transcribe)
                 ▼
n8n ─token de servicio─▶ claim → GET /internal/documents/:id/content (con reclamación)
                       → propuestas / HITL (rutas de la Fase 4.2C)
```

Se reutilizan los casos, la cola y la auditoría de la Fase 4.2C. No hay una segunda tabla de casos ni una segunda cola.

## 2. Almacenamiento

La interfaz `FileStorage` (`src/storage/file-storage.ts`) desacopla el proveedor. Los servicios de ingesta solo conocen estas operaciones:

| Operación | Uso |
|---|---|
| `put(key, stream, {contentType, size})` | Guarda un objeto nuevo y **nunca sobrescribe** uno existente |
| `get(key)` | Devuelve el contenido como stream, con su tamaño |
| `stat(key)` | Metadatos técnicos, o `null` si no existe |
| `removeAfterFailedWrite(key)` | **Solo compensación**: retira un objeto recién creado cuando PostgreSQL no confirmó. No existe borrado de negocio |

Las **claves** tienen la forma `documents|voice/<aaaa>/<mm>/<uuid>`. Las genera el backend y se validan con una expresión estricta, así que no pueden derivar del nombre del archivo ni de otros datos del cliente. Cualquier otra clave se rechaza, lo que cubre el path traversal.

Los errores del proveedor se convierten en `StorageUnavailableError`, sin rutas, claves ni credenciales en el mensaje.

### Modalidad local (`STORAGE_DRIVER=local`)

- **Solo desarrollo y pruebas.** La validación de entorno lo **rechaza en producción**, porque el disco de Render es efímero.
- **Ubicación:** por defecto `backend/.local/storage`, que está ignorado por Git (`.local/`). No existe ninguna ruta estática ni `ServeStaticModule`.
- **Escritura:** los archivos se abren con `flags: 'wx'`, de modo que fallan si ya existen y nunca se sobrescriben. Los permisos son `0600` para archivos y `0700` para directorios donde el sistema operativo los respeta; Windows los ignora.
- **Escrituras parciales:** si el flujo falla a mitad, el archivo parcial se elimina.
- **Persistencia:** estos archivos son locales y **no** persisten en Render.

### Modalidad S3-compatible (`STORAGE_DRIVER=s3`)

- **Cliente:** el oficial `@aws-sdk/client-s3`. Se crea sin conectarse; el SDK solo abre conexiones al ejecutar un comando.
- **Escritura:** `PutObject` envía `ContentLength`, `ContentType` e `IfNoneMatch: '*'` para impedir la sobrescritura. No envía ACL y no se generan URLs públicas ni firmadas: el contenido solo sale por los endpoints autenticados.
- **Credenciales:** opcionales. Si se omiten, se usa la cadena estándar del SDK, por ejemplo el rol de la instancia.
- **Checksums del SDK:** limitados a las operaciones que los exigen (`WHEN_REQUIRED`), por compatibilidad. La integridad se controla con el SHA-256 calculado al recibir.
- **Proveedor:** no se eligió ni se configuró ninguno. Las pruebas automatizadas usan dobles del cliente. En la Fase 4.2F.3 el adaptador se comprobó de punta a punta contra MinIO local con HTTPS. `npm run storage:check` comprueba cualquier bucket ([guía](../deployment/mvp-demo-setup.md#5-almacenamiento-de-pdf-y-audio)).
- **Cifrado en reposo:** debe configurarse en el bucket. AWS lo aplica por defecto; no se envía cabecera para no romper la compatibilidad con otros proveedores.

## 3. Variables de entorno

| Variable | Por defecto | Notas |
|---|---|---|
| `STORAGE_DRIVER` | `local` (fuera de producción) | `local` o `s3`. En producción es **obligatoria y debe ser `s3`** |
| `STORAGE_LOCAL_PATH` | `<cwd>/.local/storage` | Se resuelve a una ruta absoluta |
| `STORAGE_UPLOAD_TMP_PATH` | `<tmp del sistema>/notihouse-uploads` | Temporales multipart; cada uno se elimina al terminar su solicitud |
| `STORAGE_MAX_PDF_BYTES` | `10485760` (10 MiB) | Entero entre 1 y 50 MiB |
| `STORAGE_MAX_AUDIO_BYTES` | `26214400` (25 MiB) | Entero entre 1 y 100 MiB |
| `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION` | — | Obligatorias con `s3` |
| `STORAGE_S3_ENDPOINT` | — | Para proveedores compatibles. Debe ser `https` en producción y no puede contener credenciales en la URL |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | — | Las dos juntas o ninguna. Nunca aparecen en mensajes de error |
| `STORAGE_S3_FORCE_PATH_STYLE` | `false` | `true` para algunos proveedores compatibles |

Si la configuración es insuficiente, la aplicación **no arranca** y el mensaje explica qué falta, sin mostrar valores.

## 4. Política de seguridad de archivos

- **Orden de las comprobaciones:**
  - El guard JWT se ejecuta **antes** de leer el cuerpo, así que un usuario no autenticado no escribe nada en disco.
  - El cuerpo multipart se procesa en **streaming**: el archivo va directo a un temporal privado (`wx`, `0600`), sin cargarse entero en memoria. Al mismo tiempo se calculan el SHA-256, el tamaño y los primeros 4 KB y últimos 1 KB.
  - El tamaño máximo se aplica **durante** la recepción HTTP (413), no después de guardar.
- **Límites multipart:** 1 archivo en el campo `file`, 8 campos, valores de 256 bytes, nombres de campo de 50 bytes, 9 partes y 20 cabeceras.
- **Concurrencia:** como máximo **2 subidas simultáneas por usuario y 10 en total** por proceso (429).
- **Aceptación:** la **extensión**, el **Content-Type declarado** y la **firma real** deben coincidir. No basta con una de ellas.
- **Rechazos:** archivos vacíos, nombres de más de 255 bytes, y SVG, HTML, JavaScript, ejecutables, ZIP o cualquier formato no listado.
- **PDF:**
  - Exige la cabecera `%PDF-1.x`/`%PDF-2.x` y el marcador `%%EOF` al final.
  - Rechaza, de forma **heurística**, construcciones activas: `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile(s)`, `/RichMedia` y `/XFA`.
  - Los objetos comprimidos o los nombres ofuscados pueden ocultarlas, así que esto **no es una sanitización**.
- **Nombre original:** se guarda saneado (sin rutas, caracteres de control ni `<>:"|?*`, máximo 200 caracteres) y solo como metadato.
- **MIME:** se guarda el **canónico** del formato detectado, nunca el que declara el cliente.
- **Sin antimalware:** no hay análisis antimalware ni desinfección de PDF. **Ningún archivo se declara desinfectado.** El análisis antimalware es un control pendiente antes de manejar documentos reales; las demostraciones deben usar archivos ficticios.

## 5. Tipos y tamaños admitidos

| Formato | Extensión | Content-Type aceptado | MIME guardado |
|---|---|---|---|
| PDF | `.pdf` | `application/pdf` | `application/pdf` |
| WebM | `.webm` | `audio/webm` (con o sin `;codecs=`) | `audio/webm` |
| WAV | `.wav` | `audio/wav`, `audio/x-wav`, `audio/wave`, `audio/vnd.wave` | `audio/wav` |
| MP3 | `.mp3` | `audio/mpeg`, `audio/mp3` | `audio/mpeg` |
| M4A | `.m4a` | `audio/mp4`, `audio/x-m4a`, `audio/m4a` | `audio/mp4` |
| Ogg | `.ogg` | `audio/ogg` | `audio/ogg` |

Tamaño máximo: PDF 10 MiB y audio 25 MiB (configurables).

### Validación estructural de las notas de voz (Fase 4.2D.1)

Además de exigir que coincidan la extensión, el Content-Type y la firma inicial, `src/ingestion/audio-structure.ts` recorre la estructura interna del temporal recibido. Lee por desplazamiento, sin cargar el archivo en memoria y sin dependencias ni ejecutables externos.

| Formato | Qué se comprueba | Se rechaza |
|---|---|---|
| **M4A (ISO BMFF)** | Primera caja `ftyp` con una marca de audio admitida (`M4A `, `M4B `, `isom`, `iso2`–`iso6`, `mp41`, `mp42`). Árbol de cajas con tamaños dentro de los límites. Cajas `moov` (≤ 4 MiB) y `mdat` presentes. **Todas** las pistas (`trak`) con handler `soun` y un códec de audio en `stsd` (`mp4a`, `alac`, `Opus`, `fLaC`) | Pistas de video (`vide`) u otras pistas que no son de audio (415); falta de `moov` o `mdat`, cajas desbordadas o archivo truncado (400) |
| **WebM (EBML)** | Cabecera EBML con DocType `webm`. Segmento de tamaño conocido o desconocido (MediaRecorder). Elemento `Tracks` antes del primer `Cluster`. **Todas** las pistas con `TrackType = 2` (audio), sin elemento `Video` y con códec `A_OPUS` o `A_VORBIS` | Pistas de video u otros tipos, u otros códecs (415); datos antes de la descripción de pistas, elementos de tamaño inválido o segmento truncado (400) |
| **Ogg** | Se recorren **todas** las páginas con su CRC-32. Un único flujo lógico, cuya primera página declara Opus (`OpusHead` con versión y canales válidos) o Vorbis (cabecera de identificación válida). Al menos una página de datos y la última marcada como fin de flujo | Theora u otros flujos, o más de un flujo (415); CRC incorrecto, páginas truncadas, contenido tras el fin de flujo o falta de cierre (400) |
| **WAV** | `RIFF`/`WAVE` con un tamaño declarado no mayor que el archivo. Bloque `fmt ` coherente: PCM, float, A-law, µ-law o extensible; 1–8 canales; tasa entre 1 kHz y 384 kHz; 8, 16, 24 o 32 bits; `blockAlign` y `byteRate` consistentes. Bloque `data` no vacío y completo | Codificación no admitida (415); parámetros incoherentes, falta de `fmt ` o `data`, o datos truncados (400) |
| **MP3** | Etiqueta ID3v2 opcional bien formada y, después, tramas MPEG capa III **válidas y consecutivas hasta el final del archivo**: como mínimo dos, y solo se admite una etiqueta ID3v1 final de 128 bytes | Ausencia de tramas (415); trama inválida, datos ajenos intercalados o al final, o última trama incompleta (400) |

Las pruebas usan grabaciones **reales** muy pequeñas generadas con FFmpeg a partir de un tono sintético (`backend/test/fixtures/audio/`, sin voz ni datos personales), además de contenido falsificado, truncado y aleatorio. FFmpeg **no** es una dependencia del backend.

**Limitaciones de validación:**

- **Sin decodificación:** no se decodifica el audio. Un archivo estructuralmente válido puede contener muestras corruptas, y estas comprobaciones **no** equivalen a un antimalware.
- **WebM en modo live:** cuando el segmento tiene tamaño desconocido (MediaRecorder), un archivo cortado a mitad de un `Cluster` no se puede distinguir de uno completo sin decodificar.
- **M4A:** solo se aceptan pistas de audio. Un MP4 con audio y video se rechaza aunque contenga voz, y los contenedores 3GP (AMR) no se admiten.
- **MP3:** se exigen tramas capa III contiguas. Archivos con etiquetas APEv2 u otros datos al final se rechazan.
- **PDF:** no se valida el PDF completo.

## 6. Carga manual de facturas

`POST /api/v1/ingestions/documents` con JWT de usuario y `multipart/form-data`.

| Campo | Obligatorio | Descripción |
|---|---|---|
| `file` | Sí | PDF |
| `documentType` | No | `invoice` (por defecto), `payment_receipt` o `contract` |
| `obligationId` | No | Obligación **propia** (para facturas y comprobantes) |
| `contractId` | No | Contrato **propio** (para `contract`) |
| `requestId` | No | UUID de idempotencia (§13) |

- **Campos rechazados (400):** `ownerId`, `caseId`, `storageKey` y cualquier otro campo no declarado.
- **`propertyId`:** no se admite (400), porque ni `cases` ni `documents` tienen esa columna.
- **Tipo de caso:** `invoice` y `payment_receipt` crean un caso `household_obligation`; `contract` crea un caso `contract_review`.

```bash
curl -X POST http://localhost:3000/api/v1/ingestions/documents \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@factura-ficticia.pdf;type=application/pdf" \
  -F "obligationId=<uuid propio>" -F "requestId=$(uuidgen)"
```

Respuesta `201` (o `200` si es una repetición idempotente):

```json
{
  "documentId": "…", "caseId": "…", "correlationId": "…",
  "caseStatus": "received", "source": "document", "documentType": "invoice",
  "mimeType": "application/pdf", "sha256": "…", "sizeBytes": 48213,
  "job": { "type": "document.process", "status": "pending" },
  "processing": "pending", "duplicateContent": false
}
```

No se usa un estado `queued` porque no existe en el esquema. El caso queda `received` y el trabajo `pending`.

## 7. Carga de notas de voz

`POST /api/v1/ingestions/voice` con JWT y `multipart/form-data`:

| Campo | Descripción |
|---|---|
| `file` | Audio en uno de los formatos de §5 |
| `caseType` | Tipo de caso; por defecto `household_obligation` |
| `obligationId`, `rentalId` o `contractId` | Contexto opcional: **una** entidad propia, acorde al tipo |
| `requestId` | UUID de idempotencia |

Crea el documento `voice_note` (origen `voice`), un caso de origen `voice` y un trabajo `voice.transcribe`.

- **No hay transcripción ni propuesta.** La transcripción futura entrará como **propuesta** (`POST /internal/cases/:id/proposals`, `source: "stt"`) que nunca se aplica; la operación aplicable debe llegar en una propuesta `llm` posterior, con su revisión **HITL**.
- El audio nunca se guarda en PostgreSQL ni en Base64, y nunca aparece en logs ni en la auditoría.

## 8. Documentos privados

| Método | Ruta | Función |
|---|---|---|
| GET | `/api/v1/documents` | Documentos propios: más recientes primero, paginados, filtros `type`, `source` y `caseId` |
| GET | `/api/v1/documents/:id` | Metadatos |
| GET | `/api/v1/documents/:id/content` | Descarga del contenido por stream autenticado |

- **Respuestas:** `id`, `caseId`, `type`, `source`, `mimeType`, `fileName`, `sha256` y fechas. **Nunca** incluyen la clave de almacenamiento, rutas ni el propietario.
- **Recursos ajenos o inexistentes:** 404.
- **Cabeceras de la descarga:**
  - `Content-Type`: el MIME validado.
  - `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`.
  - `X-Content-Type-Options: nosniff`.
  - `Cache-Control: private, no-store`.
  - `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'`.
  - `Content-Length`.
- **Sin borrado ni reasignación:** no hay DELETE ni forma de cambiar el propietario o el caso.

## 9. Acceso del worker a archivos

`GET /api/v1/internal/documents/:id/content` exige **todo** lo siguiente:

1. Token de servicio (`Authorization: Bearer <N8N_SERVICE_TOKEN>`). Un JWT de usuario responde 401.
2. Cabeceras `X-Job-Id` y `X-Claim-Token` de una **reclamación vigente**, con el token correcto y el arrendamiento activo. Sin ellas, 400; con un token incorrecto o vencido, 409.
3. El trabajo debe pertenecer al **mismo caso** del documento; si no, 404.
4. Mismo propietario en el documento, el caso y el trabajo.
5. **Tipo de trabajo autorizado:** `document.process` para `invoice`, `payment_receipt` y `contract`; `voice.transcribe` para `voice_note`. Otro tipo, por ejemplo `hitl.decision`, responde 403.

Conocer el identificador no basta, y el token de servicio por sí solo **no** da acceso a ningún archivo. Cada lectura se audita (`document.content_access`, actor `n8n:<worker>`). Leer el archivo no cambia estados de negocio ni de proceso.

```bash
curl http://localhost:3000/api/v1/internal/documents/<id>/content \
  -H "Authorization: Bearer $N8N_SERVICE_TOKEN" \
  -H "X-Job-Id: <jobId>" -H "X-Claim-Token: <claimToken>" -o archivo
```

## 10. Casos y trabajos asociados

| Ingesta | Caso | Documento | Trabajo | Payload del trabajo |
|---|---|---|---|---|
| PDF | origen `document`, `received` | `invoice` / `payment_receipt` / `contract` | `document.process` | `documentId`, `documentType`, `mimeType`, `sizeBytes`, `caseType` y la entidad referida |
| Voz | origen `voice`, `received` | `voice_note` | `voice.transcribe` | Igual |

Los tipos de trabajo los fija el backend; el cliente no los elige. Los estados son los existentes, sin estados nuevos. La primera reclamación pasa el caso a `processing`, igual que en la 4.2C.

## 11. Recepción de facturas por Gmail

Un adjunto PDF de un buzón de Gmail **vinculado** sigue el mismo flujo de §6, con origen `gmail`: documento privado, caso y trabajo `document.process`, que consume el workflow 02. No crea propuestas ni obligaciones. El workflow que lo usa es `n8n/workflows/05-recepcion-gmail.json`, manual e inactivo.

**`POST /api/v1/internal/gmail/attachments`** (`multipart/form-data`)

- **Autenticación:** token de servicio. Un JWT de usuario o la falta de token responden 401, antes de escribir en disco.
- **Campos:** `file` (el PDF), `mailbox`, `messageId`, `partId`, `receivedAt` y, opcional, `workflowRunId`. Cualquier otro campo, como `ownerId` o `caseId`, responde 400.
- **Archivo:** la misma política y el mismo límite que una factura cargada a mano (§4).

| Respuesta | Significado |
|---|---|
| 201 | Registrado (mismo cuerpo que una ingesta manual) |
| 200 | Repetición del mismo buzón, mensaje y parte: nada nuevo |
| 400 | Contrato inválido, archivo ausente o PDF mal formado |
| 401 | Token de servicio ausente o inválido |
| 403 | Buzón sin vínculo, o vinculado a una cuenta inexistente o desactivada |
| 409 | El mismo mensaje y parte llegó con otro contenido, o el buzón se vinculó a otro propietario después de registrarlo |
| 413 / 415 | Adjunto demasiado grande / no es un PDF admitido |
| 429 / 503 | Demasiadas subidas simultáneas / almacenamiento no disponible; se puede repetir |

**Asociación buzón → propietario.** La define el operador en la variable de servidor `GMAIL_MAILBOX_LINKS` (`buzon@dominio=<uuid del perfil>`, separados por comas). Ninguna solicitud puede elegir el propietario ni crear un vínculo. Sin la variable, todo buzón responde 403, sin guardar nada. Este mecanismo sirve para un buzón de demostración; una versión para muchos usuarios necesitará que cada persona autorice su cuenta desde la aplicación y una tabla de vínculos.

**Idempotencia.** La clave es `gmail:<sha256(buzón normalizado)[:32]>:<messageId>:<partId>`, guardada en `workflow_jobs.idempotency_key`. Se usa `partId` porque Google lo documenta como identificador inmutable de la parte; `attachmentId` solo sirve para descargar y no se usa en la clave porque Google no garantiza que sea estable entre lecturas. La dirección del buzón no se guarda en claro. El nombre del archivo y su contenido no intervienen, así que un correo nuevo con un archivo idéntico es un caso nuevo, con `duplicateContent: true`.

**Auditoría.** Los eventos llevan actor `workflow` (`n8n:gmail-intake`) y, en `document.receive`, el identificador del mensaje, la parte y la fecha. No se guardan remitente, asunto ni cuerpo.

**Puesta en marcha del workflow 05** (ver los comentarios de su nodo `Configuracion`):

1. Crear en n8n una credencial `Google OAuth2 API` llamada `NotiHouse Gmail` con el alcance `https://www.googleapis.com/auth/gmail.readonly`. No reutilizar la credencial de tipo Gmail de n8n: pide acceso total al correo.
1b. **Importar el workflow resolviendo la credencial por nombre.** El JSON versionado lleva un id marcador (`nhpGmailRead0001`) porque el id real de la credencial lo genera cada instalación de n8n y no debe guardarse en Git. Para importarlo en un n8n local:

   ```bash
   node n8n/tools/import-workflow.mjs n8n/workflows/05-recepcion-gmail.json --dry-run   # muestra la sustitución
   node n8n/tools/import-workflow.mjs n8n/workflows/05-recepcion-gmail.json             # importa
   ```

   La herramienta busca en n8n (`--container`, por defecto `notihouse-n8n`) exactamente una credencial `NotiHouse Gmail` de tipo `googleOAuth2Api` y otra `NotiHouse-Pal API (servicio)`, sustituye los ids en una copia, rechaza workflows activos o con interruptores en `true`, importa y comprueba que los nodos quedaron con el id real. Solo lee id, nombre y tipo de las credenciales; no las descifra ni imprime secretos. Importar sobre un workflow ya vinculado es seguro porque vuelve a resolver los mismos ids. Si importas a mano (`n8n import:workflow`) sin la herramienta, los cuatro nodos de Google quedan sin credencial válida y hay que reasignarla en la interfaz.
2. Definir `GMAIL_MAILBOX_LINKS` en el servidor.
3. Completar `BUZON_AUTORIZADO` y `REMITENTES_AUTORIZADOS` **solo en tu n8n**, sin escribirlos en el repo: define `N8N_GMAIL_MAILBOX` y `N8N_GMAIL_SENDERS` (separados por comas) en la terminal al ejecutar `n8n/tools/import-workflow.mjs`, que los inserta en la copia que importa y los muestra parcialmente ocultos. Además, y crear en el buzón la etiqueta `notihouse-facturas-prueba`.
4. `AUTORIZAR_LECTURA_GMAIL = true` lista lo que se procesaría, sin descargar adjuntos ni escribir nada. `AUTORIZAR_INGESTA = true` además los registra.

El workflow comprueba con `users.getProfile` que la credencial corresponde al buzón autorizado, pide solo metadatos de las partes (nunca el cuerpo) y hace únicamente solicitudes GET a Gmail: no modifica, borra, responde ni marca mensajes. Reejecutarlo es seguro.

## 12. Deduplicación

| Situación | Resultado |
|---|---|
| Misma petición repetida (mismo `requestId`, mismo archivo y datos) | 200 con el documento, caso y trabajo existentes; no se guarda otro objeto |
| Mismo `requestId` con otro archivo, tipo o referencia | 409 |
| Nueva carga intencional del mismo archivo (sin `requestId` o con otro) | Nuevo documento y caso; la respuesta indica `duplicateContent: true` |
| Dos usuarios con el mismo contenido | Registros independientes; nunca se comparten documentos por coincidir el hash (`duplicateContent` solo mira los documentos propios) |
| Mismo correo de Gmail repetido | Clave por buzón + mensaje + parte: 200 sin crear nada (§11) |

El hash **no** identifica por sí solo una solicitud de negocio. La idempotencia se basa en `requestId`.

## 13. Idempotencia

- **Clave:** `ingest:<document|voice>:<propietario>:<requestId>`, guardada en `workflow_jobs.idempotency_key` (única), sin migraciones. Distingue el propietario y el tipo de operación.
- **Consulta previa:** antes de almacenar se busca la clave. Si existe y coincide (hash, tipo de documento, tipo de caso, entidad), se responde 200 sin escribir nada.
- **Solicitudes simultáneas:** la segunda transacción viola la clave única y se revierte. Su objeto recién guardado se **retira** (compensación) y se devuelve el registro ganador con 200 (verificado con solicitudes simultáneas).
- **Reintento tras un timeout HTTP:** si la primera solicitud terminó, devuelve 200 con el mismo registro. Si no terminó, la clave no existe y se procesa normalmente.
- **Fase 4.2C:** la idempotencia de casos, de propuestas y del `complete` de trabajos no se modificó.

## 14. Tratamiento de fallos

El almacenamiento de objetos y PostgreSQL **no comparten una transacción**: no hay atomicidad física entre ambos.

| Momento del fallo | Tratamiento |
|---|---|
| Validación o referencia ajena | No se escribe nada; el temporal se elimina |
| El almacenamiento falla al guardar | 503. No se crea ni caso ni documento. Se audita `document.store_failed` (`result = failure`) en una transacción propia |
| PostgreSQL falla después de guardar | La transacción se revierte entera y el objeto recién creado se **elimina** (`removeAfterFailedWrite`) |
| La compensación también falla | Se audita `document.orphaned` (`result = failure`) con la clave interna del objeto, para poder limpiarlo |
| El proceso se interrumpe entre el guardado y la confirmación | Puede quedar un objeto sin fila en `documents`. Se detecta comparando las claves del almacenamiento con `documents.storage_key`; la limpieza programada está pendiente |
| Escritura parcial | El adaptador local elimina el archivo truncado; en S3, un `PutObject` fallido no crea el objeto |

Los temporales multipart se eliminan siempre al terminar la solicitud, con éxito o con error, y nunca un objeto existente. La eliminación se completa **antes** de enviar la respuesta (Fase 4.2E.1): cuando el cliente recibe el resultado, el temporal ya no existe, aunque el disco esté lento. Las pruebas comprueban después de cada caso que el directorio temporal queda vacío, y `test/upload-cleanup.e2e-spec.ts` lo verifica con un `unlink` retrasado artificialmente.

## 15. Relación con propuestas de IA y HITL

- **Flujo futuro:**
  - n8n reclamará `document.process` o `voice.transcribe` y leerá el archivo (§9).
  - Llamará a OCR, extracción o STT y registrará el resultado como **propuesta** del caso (`source: ocr | llm | stt`) mediante la ruta de la Fase 4.2C.
  - Si hay ambigüedad, creará una solicitud **HITL**.
- **Separación:** una propuesta o una aprobación **no** crean obligaciones ni períodos. Aplicar datos aprobados requerirá operaciones de negocio específicas (Fase 4.2E).
- **Fin de la extracción:** que termine la extracción o la transcripción (`complete` del trabajo) no significa que el proceso financiero esté resuelto.

## 16. Códigos HTTP

| Código | Casos |
|---|---|
| 201 | Ingesta creada |
| 200 | Repetición idempotente, consulta o descarga |
| 400 | Archivo ausente o vacío, PDF mal formado, campos no permitidos (`ownerId`, `propertyId`…), multipart fuera de límites, faltan cabeceras de reclamación |
| 401 | Sin JWT, JWT inválido o token de servicio en una ruta de usuario; JWT de usuario en una ruta interna |
| 403 | Tipo de trabajo no autorizado para el documento; buzón de Gmail no vinculado |
| 404 | Documento o entidad referida inexistente o ajena; documento de otro caso |
| 409 | `requestId` reutilizado con otros datos; reclamación inválida o vencida |
| 413 | Archivo mayor que el máximo |
| 415 | Extensión, tipo declarado y firma no coinciden, formato no admitido, o PDF con contenido activo |
| 429 | Demasiadas subidas simultáneas |
| 503 | Almacenamiento o base de datos no disponibles |

## 17. Pruebas ejecutadas

| Archivo | Cobertura |
|---|---|
| `src/storage/local-file-storage.spec.ts` | Guardar y leer, permisos, no sobrescribir, inexistentes, 7 claves manipuladas, escritura parcial, compensación, errores sin rutas |
| `src/storage/s3-file-storage.spec.ts` | Contrato S3 con un doble del cliente (sin red): `IfNoneMatch`, sin ACL, mapeo 412/404, errores sin credenciales, delete de compensación |
| `src/ingestion/audio-structure.spec.ts` | Estructura de grabaciones reales (WebM normal y live, M4A con marca `M4A `/`isom`/`mp42`, Ogg Opus/Vorbis, MP3, WAV); rechazo de video (WebM, MP4, Theora), archivos truncados, aleatorios o falsificados, CRC Ogg alterado, códec inesperado, cajas desbordadas y basura tras las tramas MP3 |
| `src/ingestion/file-policy.spec.ts` | Firmas de los 6 formatos, 12 discrepancias, PDF vacío, truncado o con JavaScript, escaneo por fragmentos, saneamiento de nombres |
| `src/ingestion/upload-receiver.spec.ts`, `gmail/gmail.contract.spec.ts`, `config/env.validation.spec.ts` | Límite de concurrencia; claves de deduplicación y vínculos de Gmail; configuración de almacenamiento (local rechazado en producción, S3 incompleto, endpoint inseguro) |
| `test/ingestion.e2e-spec.ts` | PDF y voz de punta a punta, validaciones, referencias ajenas, idempotencia (secuencial, concurrente, conflicto), privacidad entre usuarios, documentos privados y descarga, ausencia de rutas públicas |
| `test/ingestion-worker.e2e-spec.ts` | Acceso del worker (válido, sin credenciales, JWT, token incorrecto, arrendamiento vencido, otro caso, otro propietario, tipo no autorizado); fallo de almacenamiento, de PostgreSQL y de compensación |
| `test/gmail-ingestion.e2e-spec.ts` | Recepción de Gmail: vínculo, contrato, validación del PDF, idempotencia (repetición, concurrencia, conflicto, archivo idéntico), aislamiento, auditoría y fallos |
| `n8n/tests/gmail-stack.test.mjs` | Workflow 05 real con backend real, base desechable y Gmail y Gemini simulados, hasta los workflows 02 y 03 |
| `n8n/tests/voice-stack.test.mjs` | Workflow 04 (voz) y su cierre por el 03, con backend real, base desechable, Gemini simulado y audios ficticios de `n8n/test-data/audio/`; requiere ffmpeg (`FFMPEG` o PATH) |
| `n8n/tools/import-workflow.mjs` | Importa un workflow en n8n local resolviendo credenciales por nombre y tipo (ver §11) |
| `test/ingestion-http.e2e-spec.ts` | Servidor real en un puerto TCP con `fetch` + `FormData`: login, cargas válidas e inválidas, descarga, usuario ajeno, worker, idempotencia, casos y trabajos, sin escrituras financieras |

Todas las escrituras usan PGlite y directorios temporales aislados por archivo de pruebas, que se eliminan al terminar. Ninguna prueba escribe en Neon.

La Fase 4.2F.2 repitió la idempotencia, la compensación, la descarga privada y el acceso del worker sobre PostgreSQL 18 local con conexiones independientes: `test/pg/06-ingestion.pg-spec.ts` ([resultados](../testing/postgres-concurrency-results.md)).

## 18. Limitaciones actuales

- **Sin antimalware ni sanitización de PDF:** la detección de contenido activo es heurística.
- **Validación de audio estructural, sin decodificación:** ver §5. Un WebM de MediaRecorder (tamaño desconocido) cortado a mitad de un cluster no se detecta.
- **Tamaño no persistido:** `documents` no tiene columna de tamaño; queda en el payload del trabajo y en la auditoría.
- **Límite de concurrencia por proceso:** con varias instancias habrá que llevarlo a un almacén compartido.
- **Objetos huérfanos:** se registran, pero no hay limpieza automática.
- **Gmail para un buzón de demostración:** el vínculo es una variable de servidor; no hay autorización de cuentas desde la aplicación.
- **Adaptador S3 sin proveedor elegido:** se probó contra MinIO local, no contra el proveedor final ni en Render.

## 19. Antes del despliegue en Render

1. Crear un bucket **privado** en un proveedor S3-compatible, con cifrado en reposo y sin acceso público.
2. Crear credenciales con permisos mínimos sobre ese bucket (`s3:PutObject`, `s3:GetObject` y `s3:DeleteObject`, este último solo para compensación) y configurarlas como variables secretas de Render.
3. Configurar `STORAGE_DRIVER=s3`; la aplicación no arranca en producción sin él.
4. Verificar que el proveedor soporta `If-None-Match` en `PutObject`. Si no, evaluar otra protección contra sobrescritura.
5. Incorporar el análisis antimalware antes de manejar documentos reales.
6. Programar la detección y limpieza de objetos huérfanos.
7. Llevar el límite de subidas simultáneas a un almacén compartido si hay más de una instancia.
8. Mantener HTTPS de extremo a extremo y rotar `N8N_SERVICE_TOKEN` y las credenciales de almacenamiento.

## 20. Contratos de integración para n8n

1. `POST /internal/workflow-jobs/claim` con `jobTypes: ["document.process"]` o `["voice.transcribe"]`.
2. Leer `payload.documentId`.
3. `GET /internal/documents/:documentId/content` con `X-Job-Id` y `X-Claim-Token`.
4. Procesar con el servicio externo (fase posterior) y renovar el arrendamiento con `heartbeat` si tarda.
5. `POST /internal/cases/:caseId/proposals` con `source: "ocr" | "llm" | "stt"`, `documentId` y los datos propuestos.
6. Si hay ambigüedad, `POST /internal/cases/:caseId/hitl-requests`.
7. `POST /internal/workflow-jobs/:id/complete` o `/fail`.
8. Gmail: el workflow 05 envía cada adjunto a `POST /internal/gmail/attachments` (§11), que crea el trabajo `document.process` del paso 1.

Todas las rutas internas exigen el token de servicio. Las que tocan un caso o un archivo exigen además la reclamación vigente de un trabajo de ese caso. Detalles en [workflow-integration.md](workflow-integration.md).
