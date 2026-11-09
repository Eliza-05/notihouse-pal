# Informe QA del MVP — 9 de noviembre de 2026

> Rama `qa/mvp-e2e-n8n` (creada desde `develop`, que ya contiene `diego`). Entorno **100 % local y aislado**: PostgreSQL 18 desechable, NestJS, Vite, n8n Community en Docker. **Nada de Neon `production`, Render ni Vercel** fue leído, modificado ni usado.
>
> **Etiquetas de veracidad.** Cada resultado se marca como **REAL** (servicio real), **INTEGRACIÓN LOCAL** (componentes reales del proyecto, entorno local) o **SIMULADO** (un servicio externo se sustituyó). **Gemini y Gmail NO se probaron de verdad** (§8): no hay clave ni cuenta de pruebas autorizadas. El micrófono físico tampoco.

## Resumen ejecutivo

| Área | Resultado |
|---|---|
| Frontend ↔ backend ↔ PostgreSQL ↔ n8n (navegador real) | Probado. 10 escenarios reproducibles: **152 comprobaciones, 0 fallos** en una base limpia |
| Backend | 582 unitarias + 609 e2e (PGlite) pasan; typecheck y `drizzle check` limpios; PostgreSQL 18 real: **185/186** (1 fallo **preexistente**, §4) |
| Frontend | typecheck, lint (solo *warnings*) y build OK; **14 pruebas nuevas** (el frontend no tenía ninguna) |
| n8n | A-1…A-4 y A-6 adaptados y probados; **A-5 para PDF/Gmail bloqueada por una decisión de contrato del backend** (§6) |
| Defectos corregidos | 8 (§3) |
| Gemini / Gmail / micrófono reales | **No ejecutados** (§8, §9) |

**Dictamen: GO condicional** para integrar la rama a `develop` (condiciones en §13); **NO GO** para activar los disparadores programados de n8n en producción hasta completar las pruebas reales de §9.

---

## 1. Inventario del frontend (implementado)

Rutas (`frontend/src/app/router.tsx`): `/` (landing sin sesión / resumen con sesión), `/login`, `/atencion`, `/inmuebles`, `/inmuebles/:id`, `/obligaciones`, `/obligaciones/:id`, `/arriendos`, `/arriendos/:id`, `/contratos`, `/documentos`, `/voz`, `/asistente`, `/casos`, `/casos/:id`, `/revisiones/:id`, `/alertas` y (nueva) `*` → «Página no encontrada».

## 2. Funcionalidades probadas desde el navegador (REAL: Chromium ↔ NestJS local ↔ PG18)

Todo con la cuenta de **Daniel** (`daniel.rojas@notihouse.com`, §H1) salvo el aislamiento (Laura). «Persistencia» = verificada con SQL.

| Módulo | Qué se ejecutó desde la UI | Resultado |
|---|---|---|
| Login / sesión / logout / rutas protegidas | Login real, JWT en `sessionStorage`, recarga conserva la sesión, ruta protegida sin sesión → `/login` (y vuelve a la ruta pedida), credenciales erróneas → «Correo o contraseña incorrectos.», logout | OK. Logout deja `sessionStorage` y `localStorage` vacíos. JWT vence a los 30 min y redirige a login |
| Dashboard | 8 KPIs y «Lo más urgente» con datos del backend local | OK |
| Inmuebles | Alta (validación «Ingresa un nombre»), búsqueda (debounce → `GET ?q=`), edición (`PATCH`), archivo con confirmación, detalle con obligaciones/arriendos/contratos | OK; persistido; propietario = Daniel |
| Obligaciones | Alta con recurrencia mensual, día 31, aviso 5, generación automática; detalle; **períodos**; confirmación declarativa («Pagado» + referencia) | OK. Cuerpo enviado = DTO del backend. Días 31 → 30-nov / 31-dic (D1) tras el barrido del workflow 06 |
| Arriendos | Alta (validaciones), detalle, cobros nov/dic (importe 900.000,00, vence 5), confirmación de recepción (evidencia obligatoria) | OK |
| Contratos | Alta con arriendo asociado, validación de fechas, vigencia y «Vence en 36 días» | OK (tras corrección D2). *Edición («Corregir»/«Terminar») no se ejercitó* |
| Alertas / campana / polling | Campana 9→8→7 al descartar y abrir; polling de `/alerts/summary` **cada 60 s** (medido) | OK |
| Bandeja de atención | Carga y navegación (`Decidir` → revisión) | OK |
| Documentos | Subida de PDF (201), listado, **descarga autenticada** (bytes idénticos), error claro con PDF falso | OK |
| Voz | Subida de audio (201), error claro con formato inválido, 360 px sin desborde | OK. **Grabación con micrófono: NO probada** (sin hardware) |
| Asistente de texto | Envío (201), caso `received` → `awaiting_human` tras n8n | OK |
| Casos / propuestas / HITL | Lista, detalle, revisión, **aprobar ≠ aplicar**, aplicar, «ya aplicado» | OK |
| Aislamiento | Con Laura: 404 en el caso, obligación, arriendo y revisión de Daniel; sus listas solo muestran sus datos | OK |
| Responsive / a11y | 390 px y 360 px sin desborde tras las correcciones D3/D4; `lang="es"`, un `h1`, `main` y `nav` con etiqueta en todas las pantallas; sin botones sin nombre; filtros sin etiqueta corregidos (D7) | OK. A **320 px** quedan ≈22 px de desborde (§11) |

## 3. Defectos encontrados y corregidos

| ID | Dónde | Defecto | Corrección |
|---|---|---|---|
| D1 | Frontend | `/ruta-inexistente` mostraba el error por defecto del enrutador | `NotFoundPage` + ruta `*` |
| D2 | Frontend | Mensajes de validación con nombres técnicos («endsOn no puede ser anterior a startsOn») en contratos, arriendos, períodos y cobros | Texto claro en español |
| D3 | Frontend | `/alertas` desbordaba 29 px a 390 px | Modificador `row-wrap` en el grupo de filtros |
| D4 | Frontend | `/voz` desbordaba 28 px a 360 px (`<input type=file>`) | `max-width: 100%` |
| D5 | n8n 02 y 04 | El anclaje del proveedor ignoraba palabras < 4 letras: **ETB/EPM nunca eran aplicables** (heredado del código compartido) | Nombres cortos deben aparecer como palabra completa; siglas societarias excluidas |
| D6 | Frontend | Revisión de propuestas sin acción (faltan datos / no soportada) volcaba JSON crudo (con `alertaSeguridad`) y, tras aprobar, decía «pulsa Aplicar» sin botón | Mensaje claro; sin JSON ni texto engañoso |
| D7 | Frontend | 8 controles sin nombre accesible (filtros `<select>` y entradas de archivo) | `aria-label` |
| D8 | n8n 04 (propio) | El primer anclaje que escribí descartaba importes y fechas **dictados con palabras** («cuarenta y tres mil», «doce de diciembre»), es decir, el caso normal de voz; la propuesta de «guiado» usaba la clave `guiado` en vez de `guided` del contrato | Anclaje con números en palabras en español; clave `guided` |

Además se corrigió una **expectativa obsoleta** de prueba: `backend/test/pg/00-environment.pg-spec.ts` esperaba 3 migraciones (hay 5).

## 4. Resultados reales de las pruebas automáticas

| Suite | Resultado | Evidencia |
|---|---|---|
| Backend unitarias (`npm test`) | **582/582** (31 archivos) | `docs/qa/evidence/backend-unit-e2e-lint-tsc-2026-11-09.log` |
| Backend e2e (`npm run test:e2e`, PGlite) | **609/609** (29 archivos) | idem |
| Backend typecheck / lint / `drizzle check` / build | limpios / 1 *warning* preexistente / «Everything's fine» / OK | idem |
| Backend contra **PostgreSQL 18 real** (`conc:test`) | **185/186**. Falla *Escenario J — muchas alertas re-etiquetadas*: el barrido deja 12 de 30 ocurrencias con alerta activa; las de 4–6 días quedan `no_longer_applicable` (umbral efectivo de 3 días tras el cambio D6 «aviso personalizado»). **Preexistente** (el backend no se modificó); es una expectativa de la prueba o una regla por decidir; **se deja sin cambiar** para la responsable del backend | `docs/qa/evidence/backend-pg18-real-2026-11-09.log` |
| Frontend typecheck / build / lint | OK / OK / solo *warnings* | — |
| Frontend `npm test` (nuevo) | **14/14**: cliente API (token, JSON, multipart, 401, ApiError), dinero, fechas, etiquetas | `frontend/src/**/*.test.ts` |
| n8n `workflows-static.test.mjs` (nuevo) | **83/83**: JSON válido, inactivos, sin secretos, conexiones íntegras, interruptores en `false`, código compilable, contratos A-1/A-2/A-3/A-4/A-6 | — |
| n8n `agent-eval.test.mjs` | **43/43** (Gemini simulado, 3 respuestas por caso crítico) | — |
| n8n `voice-stack.test.mjs` (04 con backend real, PG18, n8n Docker, proxy con fallos) | **99/99** | `docs/qa/evidence/voice-stack-2026-11-09.log` |
| n8n `scheduled-stack.test.mjs` | **29/29** en la 2.ª corrida (la 1.ª tuvo 28/29: «pausa por cuota», prueba por temporizador sobre el workflow 02 sin modificar; no reproducible) | `…/scheduled-stack-2026-11-09.log` |
| n8n `gmail-stack.test.mjs` | ver nota ¹ | `…/gmail-stack-2026-11-09.log` |
| **Escenarios E2E de esta rama** (`infra/qa/run-all.mjs`) | **152/152** (e01 11, e02 14, e03 7, e04 12, e05 12, e06 8, e07 13, e08 12, e10 22, e09 41) | `…/escenarios-e2e-local-2026-11-09.log` |

¹ La 1.ª corrida dio 81/82: la única falla fue el guardián «workflow 01 y frontend sin cambios» (compara el árbol de trabajo con el cierre de la Etapa 6; mis correcciones deliberadas de frontend lo activan). Se relanzó con el árbol limpio tras el commit; el resultado final se anota en la entrega.

Las pruebas existentes **no se debilitaron**. Las únicas modificaciones fueron al contrato nuevo de 04 (§5) y a la lista de migraciones.

## 5. Workflows n8n modificados

| Archivo | Cambio |
|---|---|
| `04-procesamiento-voz.json` | **A-1** reclama `voice.transcribe` y `text.interpret`; `Es texto?` omite descarga y transcripción. **A-2** esquema y prompt con las 8 intenciones; anclaje de proveedor, importe, día y fecha (cifras o palabras), evidencia literal, fechas relativas no convertidas, anti-inyección, nunca confirma pagos. **A-3** `Resolver en backend` (`POST /internal/cases/:id/assistant/resolve`) y `Armar propuesta` que registra propuesta + HITL según `outcome` (`applicable`→`data_confirmation`; `needs_choice`→`conflict_resolution` + `target_selection`; el resto → propuesta no aplicable). **Nunca aplica** |
| `06-mantenimiento-programado.json` (generado por `n8n/tests/build-workflow-06.mjs`) | **A-4** bloque de recurrencia **antes** de alertas: `POST /internal/recurrence/generate`, cursor hasta `complete=true`, interruptor propio `AUTORIZAR_RECURRENCIA=false`, cadencia 6 h en modo programado. Un fallo (p. ej. kill switch `recurrence_generation`) no bloquea las alertas pero deja la ejecución en **error** |
| `02-procesamiento-documental.json` | Solo el anclaje de proveedor (D5) |
| `03`, `05`, `01` | **Sin cambios** (03 verificado; 05 probado por `gmail-stack`) |
| `n8n/tools/import-workflow.mjs` | Opciones `--api-base`, `--gemini-base`, `--qa-authorize` (**solo hosts locales**; `--qa-authorize` exige `--api-base`); el repo nunca puede traer interruptores en `true` |

Todos los JSON versionados quedan **inactivos**, con todos los interruptores `AUTORIZAR_*`/`AUTOMATIZACION_*` en `false`, sin credenciales ni URLs locales. Los disparadores programados **no se activaron**; todas las ejecuciones fueron manuales (CLI `n8n execute` en la instancia QA).

## 6. Estado de A-1…A-7

| ID | Estado | Evidencia |
|---|---|---|
| A-1 | **Completa y probada localmente** | e01, e09 (texto: claim, interpretación, sin descargar audio, fallo/reintento) |
| A-2 | **Completa; probada con Gemini simulado** (sin cuota real) | `agent-eval`, `voice-stack`, e09 (inyección, proveedor inventado) |
| A-3 | **Completa; probada** con texto y voz y los 6 resultados (el `informational` real no se obtuvo: el mock lo resolvió como `needs_completion`; cubierto en pruebas del backend) | e01, e02, e03, e10 |
| A-4 | **Completa y probada** (generación, idempotencia, kill switch, alertas posteriores). La paginación por cursor con `complete=false` **no** se ejercitó con volumen (requiere >100 elementos); queda cubierta por el código del bucle y la prueba estática | e05, e06 |
| A-5 | **Parcial.** Texto/voz sí: `update_occurrence_details` y `create_obligation_occurrence`, rechazo de duplicados e idempotencia. **PDF y Gmail NO usan `resolve`**: el backend lo prohíbe a propósito para `document.process` (403, «lista cerrada», con prueba). Consecuencia verificada en e04: un PDF de un período ya generado produce `create_*` y **al aplicar responde 409** (sin duplicar, pero sin la opción de actualizar). **Decisión pendiente:** autorizar `document.process` en `resolve` (cambio de una línea + prueba) y adaptar 02 | e04, e09 |
| A-6 | **Completa y probada** con las 6 acciones aplicables (`create_obligation_occurrence`, `create_obligation_with_occurrence`, `create_recurring_obligation`, `update_obligation_schedule`, `update_occurrence_details`, `create_recurring_rental`): aprobar ≠ aplicar, aplicación única/idempotente, cierre `completed` por el workflow 03, rechazo, expiración (workflow 06), auditoría | e01, e02, e04, e07, e10 |
| A-7 | **No implementada** (opcional, fuera de alcance) | — |

## 7. Escenarios E2E ejecutados

Clasificación: **R** = servicio real; **IL** = integración local; **S** = simulado.

| # | Escenario | Real / simulado |
|---|---|---|
| 1 | Obligación por texto: mensaje → caso → trabajo → n8n → resolve → propuesta → HITL → aprobar → aplicar → obligación + períodos → workflow 03. **Repetido desde la interfaz del navegador** | PG18 R, NestJS R, n8n R, navegador R; **Gemini S** |
| 2 | Modificación por texto: diff `{expected:{dueDay:10}, changes:{dueDay:20}}`; **D12**: la fecha propia de una factura (25-nov) no se sobrescribe, el período sin fecha propia sí | IL; Gemini S |
| 3 | Nota de voz: audio ficticio real por la UI y la API; descarga del audio por n8n; **transcripción SIMULADA** (la propuesta `stt` es evidencia no aplicable; nunca se aplica) | IL; **STT e interpretación S** |
| 4 | Factura PDF: subida/descarga autenticadas, texto extraído **por n8n (real)**, propuesta, HITL, aplicar, cierre; duplicado → 409 | IL; **extracción S** |
| 5 | Recurrencia: obligación creada desde la UI → barrido del 06 → períodos; 2.ª ejecución 0 nuevos; kill switch → error visible + alertas evaluadas | IL; sin Gemini |
| 6 | Arriendos: alta por la UI, cobros nov/dic (importe/fecha), idempotencia, confirmación con evidencia, aislamiento | IL |
| 7 | HITL: aplicar sin aprobar → 409; otro usuario → 404; rechazo; no se cambia una decisión; expiración vía workflow 06; «silencio ≠ aprobación» | IL; Gemini S |
| 8 | **Gmail nivel 1 (SIMULADO)**: endpoint interno del workflow 05 con adjuntos ficticios: 201, deduplicación 200, 409/403/400/401, dueño correcto, extracción por el 02. No hubo cuenta Gmail | **Gmail S** |
| 9 | Seguridad: 401 (×6), 400 (×4), 404, 413, 415, 429 (login y 3 textos abiertos), 409, 403, 503 (kill switch), concurrencia (6 envíos y `requestId` ×4 → 1 caso), inyección, modelo que inventa datos, 500 de Gemini con *backoff* y reintento sin duplicados, kill switch `text_processing` | IL; Gemini S |
| 10 | Resultados de `resolve`: `needs_choice` (2 «Claro», sin elegir por el usuario), `guided_manual` (solo navega; nada pagado), `create_recurring_rental`, `create_obligation_occurrence`, `needs_completion` | IL; Gemini S |

Reproducir (todo local): §14.

## 8. Estado real de Gemini y Gmail

* **Gemini real: NO ejecutado.** Todas las respuestas del «modelo» salen de `infra/qa/mock-gemini.mjs` (marca `modelVersion: "SIMULADO-qa"`) o de proxies de las pruebas. **Ninguna prueba de este informe es una interpretación real.** No se gastó cuota.
* **Gmail real: NO ejecutado.** No hay credencial OAuth de una cuenta de pruebas autorizada. La lógica del workflow 05 (decodificación, deduplicación, errores 503) la cubre `gmail-stack.test.mjs` con Gmail simulado; el endpoint del backend, el escenario 8.
* **Cuota:** cada ejecución **manual** de 02/04 gasta **1 llamada de sondeo** (`Probar Gemini`) además de 1 por trabajo (texto/PDF) y 2 por nota de voz (transcribir + interpretar). Con 20 peticiones/día en el nivel gratuito, ver el plan en §9.

## 9. Lo que falta por probar con servicios reales

Ver la lista numerada de la entrega final y el plan de llamadas de Gemini: **máximo 8 llamadas**: 1 sondeo + 1 texto de obligación + 1 texto de modificación + 1 texto con inyección + 1 PDF + 2 de voz (+ 1 de reserva).

## 10. Funcionalidades frontend pendientes (no implementadas)

* **N9 / A-7 «continuaciones»** (`POST /cases/:id/continuations`): tras un `needs_choice` la UI muestra las alternativas, pero **elegir una no ejecuta nada**; la persona debe editar manualmente.
* Edición manual guiada hacia el destino de las propuestas `guided` (hoy la UI solo informa «complétala manualmente»).
* Detalle de la página de arriendos no es navegable desde el alias (solo desde el nombre del inmueble) — observación de diseño.

## 11. Riesgos residuales

1. **Interpretación real sin probar** (prompt, esquema, límites de Gemini 2.5 Flash, latencia de Render).
2. **A-5 para PDF/Gmail** (409 al aplicar sobre un período ya generado).
3. `resolve` asigna **COP** si el mensaje no dice moneda: el usuario lo ve en la revisión, pero ya no queda «no aplicable por falta de moneda» como en la versión anterior del 04.
4. Prueba PG real `Escenario J` fallando (preexistente, §4).
5. El JWT dura 30 minutos sin refresco: una demostración larga cierra la sesión.
6. Login limitado a 5/min por IP: repetir intentos fallidos en la sustentación bloquea el acceso un minuto.
7. A 320 px de ancho hay ≈22 px de desborde horizontal (360 px y 390 px OK).
8. Grabación de audio en móviles (iOS/Safari) sin verificar.
9. Almacenamiento: solo se probó el driver local; el driver S3/R2 de producción no.

## 12. Estado de la rama QA

`qa/mvp-e2e-n8n`: 5 commits sobre `develop` (`7542b98`), publicada solo en `origin/qa/mvp-e2e-n8n`. Sin cambios en `develop`/`main`, Neon, Render ni Vercel. El **backend de producción no cambió** (solo una prueba `pg-spec`).

## 13. Cambios para revisar antes del merge

1. `n8n/workflows/04`, `06` (y su constructor), `02` (una función). Revisar prompts y `Armar propuesta`.
2. `frontend/src`: `NotFoundPage`, `router.tsx`, mensajes de formularios, `HitlDetailPage`, `AlertsPage`/`tokens.css`, `VoicePage`, `aria-label` en 6 páginas; `package.json` (vitest).
3. `n8n/tools/import-workflow.mjs` (opciones QA) y `n8n/tests/*`.
4. `infra/qa/**` (compose, scripts y escenarios; sin secretos) y `docs/qa/**`.
5. `backend/test/pg/00-environment.pg-spec.ts` (lista de migraciones).
6. **Antes de importar a la instancia productiva de n8n**: restaurar `apiBase`/`geminiBase` (el importador ya los deja intactos sin opciones QA) y no usar `--qa-authorize`.
7. Decidir A-5 (PDF) y el *Escenario J*.

## 14. Escenarios demostrables hoy en la sustentación

Con la advertencia de que la IA está **simulada** hasta completar §9: (1) obligación por texto de punta a punta; (2) modificación con diff y protección D12; (3) subida de voz y PDF con propuesta y revisión humana; (4) aprobar ≠ aplicar y rechazo/expiración; (5) recurrencia (workflow 06 manual); (6) arriendos con cobros; (7) aislamiento entre usuarios; (8) alertas/campana; (9) kill switch y errores claros. **No demostrar como reales**: transcripción, extracción de PDF, Gmail.

---

## H. Usuarios, credenciales y autenticación de las pruebas

1. **Cuenta de Daniel.** El seed oficial define cuatro usuarios demo; Daniel es `daniel.rojas@notihouse.com` (Daniel Rojas), verificado en `backend/src/database/seed/demo-data.ts`. Se creó con el **seed oficial** (`seed-demo.js`) contra PostgreSQL local; contraseña aleatoria propia del entorno (hash Argon2id). La segunda cuenta (aislamiento) es Laura (`laura.martinez@…`); Andrés se usó para concurrencia.
2. **Credenciales.** Se guardan solo en `.local/qa/qa.env` (ignorado por Git, permisos restringidos); nunca se imprimieron. El navegador las recibió desde un servidor local temporal (`infra/qa/cred-server.mjs`, 127.0.0.1) y los scripts usan `--env-file`. No se leyó ni se usó `backend/.env` (ni sus valores): el backend QA se ejecuta **desde otro directorio** con un entorno construido desde cero, y se rechaza cualquier destino distinto de `127.0.0.1:55433`.
3. **Login real en el navegador**: confirmado (§2). Persistencia en PostgreSQL: confirmada con SQL en cada módulo. Aislamiento: §2.
4. **Credenciales de n8n QA**: `N8N_SERVICE_TOKEN` generado solo para QA, cargado en NestJS (variable de entorno) y en una credencial *Header Auth* cifrada de n8n QA; **no está en ningún JSON**. Verificado: sin token → 401; token inválido → 401; JWT de usuario en ruta interna → 401; claim, `resolve`, `complete` y `fail` con el token → OK.
5. **Red Docker**: dentro del contenedor `localhost` es el propio contenedor; se usa `host.docker.internal` (demostrado: `localhost:3100` rechazado, `host.docker.internal:3100` responde).
6. **Aislamiento de recursos**: proyecto Compose `notihouse-qa` (volúmenes `notihouse-qa-pg`/`-n8n`, puertos 55433/5679/3100/5174/3200). Los contenedores y volúmenes preexistentes (`notihouse-n8n`, `n8n_data`, `notihouse_n8n_data`, `notihouse-concurrency-*`) **no se modificaron**. Para la suite PG real se **arrancó** (sin recrear) `notihouse-concurrency-postgres`, se aplicó `conc:init` (migraciones 0003/0004 a esa BD descartable) y se **volvió a detener**.
7. **Limpieza** (cuando ya no se necesite): `docker compose -p notihouse-qa -f infra/qa/docker-compose.qa.yml --env-file .local/qa/qa.env down -v` (solo ese proyecto) y borrar `.local/qa/`.

## Reproducir

Ver `infra/qa/README.md`.
