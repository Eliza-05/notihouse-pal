# Refactor UX, notificaciones y QA — cierre del 11 de noviembre de 2026

Rama `develop` (base `927f832`). **Sin commit ni push**: todos los cambios están en el árbol de trabajo para revisión.
No se modificaron datos de Neon, workflows de n8n, credenciales, Render ni Vercel; no se consumió Gemini; no se hicieron nuevas ingestas de Gmail.

## A. Resumen ejecutivo

- Se conservó la identidad visual (paleta, tipografía, tarjetas, navegación, botones). Solo se añadieron componentes que reutilizan los tokens existentes.
- Los importes y fechas se presentan al estilo colombiano (`$87.400 COP`, `22 de diciembre de 2026`) en todas las pantallas; la API y la base de datos siguen usando el texto decimal original.
- **Aprobar ≠ aplicar ≠ cerrar** ahora se comunica con el estado real de la propuesta. Hallazgo clave: la API no informaba si una propuesta ya estaba aplicada, así que tras recargar reaparecía el botón «Aplicar». Se añadió el campo `appliedAt` (extensión mínima del backend, **sin desplegar**) y el frontend funciona con o sin él.
- Notificaciones dentro de la aplicación: avisos flotantes, campana con panel y contador, sin duplicados y aisladas por usuario.
- Estados de carga, esqueletos, botones con spinner, mensajes de error amigables, `timeout` del cliente y favicon propio.
- 8 facturas PDF ficticias creadas y validadas en `Descargas\NotiHouse-Pal-Demo\`.
- Estado final: frontend `tsc` OK, build OK, Vitest **201/201** (línea base 99/99); backend unitarias **586/586** y e2e **613/613** (línea base 582; ver sección I).

## B. Auditoría inicial (antes de modificar)

Línea base del 11-nov: `tsc` OK, `oxlint` solo avisos, Vitest 99/99, build OK, backend unitarias 582/582 (el e2e no se ejecutó: usaría la base de producción).

Hallazgos principales:

| # | Hallazgo | Tipo |
|---|---|---|
| 1 | Tras aprobar y aplicar, al recargar volvía a aparecer «Aplicar»: la API no exponía si la propuesta estaba aplicada | Funcional (backend + frontend) |
| 2 | Importes como `87400.00` y fechas ISO visibles en propuestas, resúmenes y textos | UX |
| 3 | «Monto esperado: Sin monto» en obligaciones únicas; `frequency=monthly` por defecto parecía recurrencia | UX |
| 4 | Dos revisiones con el mismo título «Revisión: confirmación de datos» | UX |
| 5 | El comentario de HITL se guardaba pero no se mostraba en ninguna pantalla; el campo aparecía sin explicación | UX |
| 6 | «Completado» en listas aunque la propuesta no se hubiera aplicado | UX / semántica |
| 7 | Errores de red/validación silenciosos en varios formularios (solo se mostraban si era `ApiError`) | Funcional |
| 8 | Modales «Terminar contrato» y «Archivar inmueble» sin manejo de error ni indicador de carga | Funcional |
| 9 | Subida de documentos: se podía lanzar una segunda subida mientras la primera estaba en curso; zona de carga inaccesible con teclado | Funcional / accesibilidad |
| 10 | Documentos mostraba `invoice` y `gmail` sin traducir | UX |
| 11 | Botones de espera solo con texto («Enviando…») y sin spinner; listas con «Cargando…» y sin esqueleto | UX |
| 12 | Favicon inexistente (404) | Cosmético |
| 13 | Sin tiempo límite en las peticiones (Render dormido podía dejar la pantalla esperando indefinidamente) | Estabilidad |

## C. Refactor aplicado

| Problema | Archivo / componente | Corrección | Verificación |
|---|---|---|---|
| Formato de importes | `lib/format/money.ts` | `formatMoney` quita «,00» y `formatMoneyWithCurrency` da `$87.400 COP` (antes duplicaba la moneda en otras divisas) | Vitest `format.test.ts`; navegador |
| Fechas largas | `lib/format/dates.ts` | `formatLongDate`, `formatPeriod` sin pasar por `Date` (sin desfase de zona) | Vitest; navegador |
| `appliedAt` desconocido | `backend/src/cases/cases.service.ts`, `hitl.service.ts`, `dto/process.dto.ts` | Subconsulta de solo lectura en las lecturas de propuestas; los INSERT/UPDATE no cambian | Unitaria nueva + consulta SELECT de solo lectura contra Neon (devuelve la fecha real de aplicación de la propuesta Aseo) |
| Estado real de la revisión | `cases/reviewState.ts`, `HitlDetailPage.tsx` | Etapas: pendiente, aprobada–falta aplicar, aprobada (sin dato), aplicada, revisada, elección registrada, rechazada, vencida | `reviewState.test.ts`, `HitlReview.test.tsx`; navegador (simulado) |
| Títulos iguales | `cases/reviewSummary.ts`, `AttentionRow.tsx` | «Revisar factura de Aseo Verde de Prueba S.A.S. — $87.400», «Confirmar obligación recurrente ENS-1114 — $31.000» | Vitest; navegador con datos reales |
| Monto «Sin monto» | `obligations/presentation.ts`, `ObligationDetailPage.tsx`, `ObligationsPage.tsx` | «Importe del período: $87.400 COP» y nota «no se genera sola»; la frecuencia solo se menciona si `autoGenerate` es verdadero | `presentation.test.ts`; navegador con la obligación real |
| Comentario HITL | `HitlDetailPage.tsx` | Nota opcional plegable al aprobar; «Motivo del rechazo» solo al rechazar (con confirmación); se muestra después en la revisión | `HitlReview.test.tsx`; navegador |
| «Completado» ambiguo | `labels.ts`, `cases/caseProgress.ts`, `CaseDetailPage.tsx`, `CasesPage.tsx` | «Cerrado» en el sistema; la solicitud muestra pasos reales (recibido, análisis, tu revisión, aplicación) | `caseProgress.test.ts`; navegador |
| Mensajes técnicos | `lib/api/messages.ts` + todos los formularios | `friendlyError` por estado HTTP; respeta frases claras del backend, sustituye textos técnicos | `messages.test.ts` |
| Errores silenciosos | 6 modales de formulario | Siempre muestran un mensaje (también si es error de red) | Vitest `MoneyForms.test.tsx` |
| Modales sin carga/error | `ContractsPage`, `PropertiesPage` | `LoadingButton`, errores y toast | Typecheck; revisión de código (sin prueba de navegador propia) |
| Doble subida | `DocumentsPage.tsx` | Bloqueo mientras sube; zona de carga con teclado | `DocumentsPage.test.tsx`; navegador |
| Documentos sin traducir | `DocumentsPage.tsx`, `labels.ts` | Tipo y origen en español | Navegador con datos reales |
| Sin timeout | `lib/api/client.ts`, `errors.ts` | 60 s por defecto (Render dormido), `RequestTimeoutError` distinto de «sin red» | `messages.test.ts` (con temporizadores simulados) |
| Botones/confirmaciones | `ConfirmOccurrenceModal`, `ConfirmChargeModal` | «Declarar como pagado/atendido/recibido», con importe y vencimiento y aviso de que después no se podrá editar | Typecheck; no hay prueba automática dedicada |

## D. Notificaciones

**Dónde viven:** `features/notifications/` (`derive.ts` lógica pura, `hooks.ts`, `NotificationsProvider`, `NotificationBell`, `NotificationToaster`) y `components/Toasts.tsx`. No se creó un sistema paralelo de alertas: se derivan de los endpoints existentes (`/hitl-requests`, `/attention`) y de `appliedAt`.

**Qué notifica**
- Alta prioridad (con aviso flotante): revisión HITL pendiente (factura, propuesta, elección, solicitud que necesita atención) y propuesta aprobada que falta aplicar.
- Media (solo en la campana): vencimientos de obligaciones, cobros y contratos que ya calcula la Bandeja.
- No notifican: editar, abrir pantallas, consultar documentos, guardar. Esas acciones usan toasts de feedback que no entran en el panel.

**Aviso «aprobada que falta aplicar»:** solo se emite cuando el backend afirma `appliedAt = null`. Con el backend actual (sin el campo) no se afirma nada.

**Avisos flotantes:** esquina inferior derecha (sobre el dock en móvil), entrada/salida suaves, pausa al pasar el cursor, máximo 3, `aria-live` cortés para avisos y asertivo para errores, respetan `prefers-reduced-motion`. Cada aviso enlaza a **su** revisión por id (no a una antigua).

**Campana:** botón con panel (Escape y clic fuera lo cierran, devuelve el foco). El contador cuenta lo que pide atención; un vencimiento «próximo» sin alerta se lista pero no cuenta. Sin pendientes: «No tienes pendientes por ahora.»

**Sin duplicados:** clave estable `usuario:recurso:id:evento`; la primera carga solo fija la línea base y muestra **un** resumen por sesión; después cada clave se anuncia una vez (memoria en `sessionStorage` por usuario). Si ya estás en la pantalla del aviso, no se repite.

**Actualización:** una sola instancia de consultas compartida (campana y avisos), polling de 30–60 s solo con la pestaña visible y revalidación al volver; tras decidir/aplicar se invalida la caché y el contador baja al instante.

**Cierre de sesión / cambio de usuario:** `AuthCacheSync` vacía la caché y los toasts; las claves incluyen el id de usuario.

**Workflow 06:** sigue inactivo y no se tocó. Las alertas persistentes (`/alerts`) dependen de él: en producción hay 0 alertas generadas. La campana muestra los vencimientos que la Bandeja ya calcula sin él, pero los avisos «vence en N días» como alertas programadas y su estado de lectura requieren el 06.

**Qué NO es:** no son notificaciones push del sistema operativo. Solo existen con la aplicación abierta. Web Push/FCM con la aplicación cerrada queda como ampliación documentada (requiere service worker, claves VAPID/FCM y un emisor en el backend).

## E. Verificaciones

| Verificación | Resultado |
|---|---|
| `tsc -b` (frontend) | OK |
| `oxlint` (frontend) | Solo avisos (react-refresh y compilador); sin errores |
| Vitest (frontend) | **201/201** en 17 archivos (antes 99/99 en 8) |
| Build de producción | OK |
| Backend: typecheck, lint, unitarias | OK; **585/585** (582 + 3 nuevas) |
| Backend e2e | Corregido en la auditoría final (sección I): NO usan `DATABASE_URL`, corren sobre PGlite en memoria. Resultado final 613/613 |

**Navegador real (Chromium, sesión de Camila contra Render, solo lecturas; toda escritura bloqueada o simulada):**
Resumen, Bandeja, Obligaciones (lista y detalle de Aseo Verde), Documentos, Mis solicitudes, detalle de solicitud, revisión pendiente real, campana, aviso de resumen, favicon (200, sin 404), vista a 390 px sin desborde horizontal en 9 rutas, cero errores de consola en la navegación normal.

**Pruebas simuladas en el navegador (respuestas controladas, no producción):** servidor caído, 500, 429, respuesta lenta (esqueleto visible y desaparece), «Reintentar», sesión vencida (401 → inicio de sesión), subida con 415/409/lenta/éxito, login con espera y credenciales erróneas, aparición de una revisión nueva (aviso flotante tras el polling real de ~30 s, contador 1→2), aprobar con nota → «falta aplicar» → aplicar → recargar (sin botón Aplicar), rechazar con motivo.

**Casos no ejecutados:** tiempo de espera de 60 s real (probado solo con temporizadores simulados), 403/404 en navegador (probados por unitarias), trabajo de IA fallido y revisión ya resuelta en navegador (por unitarias), Gemini real, grabación con micrófono, lectores de pantalla y auditoría automática de contraste/axe, y la transición real `appliedAt` (el backend desplegado aún no lo expone).

## F. Facturas PDF

Carpeta: `C:\Users\eliza\Downloads\NotiHouse-Pal-Demo\` — **8 PDF**, `README.md` con inventario y `_generador\` (scripts de generación y validación).
Generados con ReportLab, estáticos, con proveedores ficticios, referencias `DEMO-…` y aviso de documento ficticio. Resultado de validación: **8/8 aprobados** (cabecera y `%%EOF`, sin cifrado, 1 página, ≤ 10 MiB, 0 coincidencias de `PDF_ACTIVE_CONTENT` completo y por fragmentos, sin acciones/adjuntos/formularios, texto extraído con `pdf-parse` de n8n sin ejecutar workflows, campos clave recuperables, sin datos reales, SHA-256 en el README). La 08 es incompleta a propósito (sin vencimiento ni período). La validación de texto no garantiza lo que devolverá Gemini.

## G. Pendientes técnicos

**Bloqueantes:** ninguno para la demostración.

**Requieren autorización:**
- Desplegar el backend con `appliedAt` (hasta entonces la UI muestra «Revisión cerrada»/«Aprobada» sin afirmar si se aplicó).
- Probar `appliedAt` en el PostgreSQL 18 de `infra/qa` antes de desplegar (sección I.10).
- Activar el workflow 06 para alertas persistentes; reenvío del mismo correo (idempotencia de Gmail).
- Probar con Gemini real la factura incompleta (08) y las demás.

**Mejoras menores:**
- La barra lateral no resalta «Mis solicitudes» en `/revisiones/:id`.
- «Mis solicitudes» muestra el mismo tipo «Obligación del hogar» en todas las filas; convendría añadir proveedor o importe.
- El mensaje de las alertas viene del backend en texto libre.
- Sin pruebas de navegador propias para los modales de terminar contrato y archivar inmueble.

**Fuera del alcance del MVP:** Web Push con la aplicación cerrada, OCR de PDF escaneados, continuaciones A-7, ejecución de pagos o cobros.

## H. Git

Archivos modificados: 43 (backend 3, frontend 40). Archivos nuevos: 29 entre código, pruebas, estilos y `frontend/public/` (`favicon.svg`, `apple-touch-icon.png`), incluido este informe. Árbol de trabajo con cambios sin confirmar; **no se hizo commit ni push**, ni merge ni operaciones destructivas.

---

## Estados de carga, feedback visual y favicon

**Componentes** (`components/Feedback.tsx`, `Toasts.tsx`): `Spinner`, `LoadingButton`, `Skeleton`, `SkeletonRows/Table/Stats/Card`, `ToastProvider`/`useToast`/`ToastViewport`.

**Patrones elegidos**
- *Spinner en el botón* (`LoadingButton`): inicio de sesión, guardar formularios, aprobar/aplicar/rechazar, confirmar pagos, terminar contrato, archivar inmueble, enviar mensaje y nota de voz. Deshabilita el botón (no admite doble envío), conserva el ancho y expone `aria-busy`.
- *Esqueletos* con la forma real del contenido: Resumen (misma cuadrícula de 3 columnas), Bandeja, tablas de listas, detalles y panel de notificaciones. Las actualizaciones en segundo plano no vuelven a mostrar el esqueleto: se conserva el contenido anterior.
- *Sin barras de progreso*: no hay progreso medible (`fetch` no informa bytes y Gemini/n8n son asíncronos). Se usa un indicador indeterminado con el estado real («Enviando tu factura…»).
- *Estados de IA respaldados por el sistema*: recibido → en cola/procesando → análisis terminado → revisión pendiente → aprobada → aplicada, construidos solo con estado del caso, revisiones y `appliedAt`. Si tarda más de 90 s dice «sigue procesándose; puedes seguir usando NotiHouse-Pal y verlo en Mis solicitudes», sin prometer un tiempo restante.
- *Feedback de acción* (toast discreto, éxitos repetidos fusionados, errores más tiempo) separado de *notificación relevante* (campana).

**Problemas corregidos:** doble subida, errores de red silenciosos, indicadores sin fin ante un fallo (siempre se restablecen, probado), zona de carga sin teclado, anuncios repetidos (regiones `aria-live` fijas, no se anuncia cada ciclo de polling).

**Accesibilidad y movimiento:** `aria-busy`, regiones `role=status`/`alert` en el contenedor de toasts, texto oculto «Cargando…» una sola vez por región, `prefers-reduced-motion` (sin brillo en esqueletos, giro lento, sin desplazamientos), foco devuelto a la campana, limpieza de intervalos y listeners.

**Favicon:** `frontend/public/favicon.svg` (la misma casita del panel sobre el degradado rojo de marca), `apple-touch-icon.png` de 180 px generado desde el mismo SVG, `theme-color` y título «NotiHouse-Pal»; se eliminó el comentario de «sin favicon». Verificado en navegador: `/favicon.svg` y `/apple-touch-icon.png` responden 200 y no hay 404 en consola.

**Verificaciones satisfactorias:** indicadores aparecen y desaparecen (también tras error), sin envíos duplicados, esqueleto sin saltos de columnas, estados de IA coherentes con los datos, navegación disponible durante la espera, avisos flotantes junto a los indicadores, sin avisos duplicados, favicon sin 404, móvil y escritorio sin desborde, sin regresiones en formularios, HITL, obligaciones ni carga de documentos (201/201).


---

## I. Auditoría final de QA (antes de commit) — 11 de noviembre de 2026

**Veredicto: LISTO CON OBSERVACIONES.** Probado solo en local y con simulaciones; no se afirma nada sobre producción.

### I.1 Auditoría del diff
- Sin secretos, tokens ni cadenas de conexión en el diff ni en los archivos nuevos (búsqueda de `AIza`, `postgres://`, `sk-…`, `password/token/secret` en líneas añadidas). `.env`, `.local/`, `.playwright-mcp/` y `docs/qa/evidence/` están ignorados por Git.
- Sin dependencias nuevas (`package.json` y lockfiles sin cambios). Sin archivos temporales ni artefactos de pruebas entre los cambios.
- Todo el diff pertenece al refactor (frontend de UX, notificaciones y errores; 3 archivos de backend para `appliedAt`; favicon; informe). No se tocó trabajo de otros compañeros.
- Contratos: único cambio de API = campo opcional `appliedAt` en propuestas (solo lecturas). Los INSERT/UPDATE siguen con `proposalColumns`.

### I.2 Defectos encontrados y corregidos
| # | Defecto | Gravedad | Corrección | Prueba |
|---|---|---|---|---|
| 1 | **`appliedAt` devolvía siempre `null`.** En consultas de una sola tabla Drizzle elimina el prefijo y la subconsulta quedaba `pa.proposal_id = "id"` (el `id` se resuelve a `pa.id`). Tras desplegar, «Aplicar» habría reaparecido al recargar una propuesta ya aplicada. La prueba anterior no lo detectaba porque renderizaba el fragmento suelto | Alta (latente, no desplegada) | Referencia calificada a mano `"case_proposals"."id"` en `cases.service.ts` | Nueva prueba sobre el SELECT completo; el e2e ahora ve `null` → fecha |
| 2 | `appliedAt` salía con el formato crudo del driver (`2026-11-11 17:11:19.749-05`), distinto del ISO del resto de fechas | Media | `to_char(… at time zone 'UTC', ISO 8601)`; el DTO declara `string \| null` | e2e afirma el formato ISO |
| 3 | El e2e `preserves the proposal history` fallaba por el campo nuevo (cambio de contrato legítimo, no regresión) | — | Compara el resto de campos y afirma `appliedAt: null → ISO`. No se debilitó ninguna otra aserción | e2e 613/613 |
| 4 | Tras un **timeout en una escritura** (subir, aprobar, aplicar) el mensaje solo decía «vuelve a intentarlo», aunque el servidor pudo haberla procesado | Media | `RequestTimeoutError.isWrite`; mensaje específico: «es posible que la acción sí se haya registrado: revisa Mis solicitudes o recarga…» | `messages.test.ts` |
| 5 | El informe afirmaba que los e2e usarían la base de producción | Documental | Corregido: `test/support/test-app.ts` sustituye `PG_POOL` y `DRIZZLE` por PGlite en memoria; JWT, token y almacenamiento aleatorios y temporales; `DATABASE_URL` solo se valida, nunca se conecta | e2e ejecutados |

### I.3 Compatibilidad con el backend actual de Render (sin `appliedAt`)
`reviewState.ts` distingue tres casos (cubiertos por `reviewState.test.ts` y `derive.test.ts`):
- campo ausente → «Aprobada» neutral, **sin** botón «Aplicar» y sin aviso «falta aplicar»;
- `appliedAt = null` → «Aprobada, falta aplicar» (solo si el backend lo afirma);
- `appliedAt` con fecha, o aplicación hecha en esta sesión → «Aplicada».

Aprobación, cierre del caso («Cerrado») y aplicación son estados distintos; nunca se muestra «Aplicada» sin dato. Aplicar es idempotente en el servidor (segunda aplicación → 200 sin duplicar; e2e `proposal-application`).
**Limitación:** la transición real con `appliedAt` no puede verse en Render hasta desplegar el backend; solo está probada con unitarias, e2e en PGlite y simulación en navegador.

### I.4 Navegador (Fase 3)
**No se repitió** el recorrido completo. Se conserva la evidencia de la sección E (sesión anterior, Chromium contra Render solo en lectura, escrituras simuladas). En esta auditoría no se abrió el navegador: la verificación fue por código, pruebas automáticas y un PDF renderizado. Queda pendiente un repaso visual humano antes de la demostración (lectores de pantalla y axe tampoco se ejecutaron).

### I.5 Notificaciones (Fase 4)
Cubiertas por 13 pruebas de lógica (`derive.test.ts`) y 9 de integración (`Notifications.test.tsx`): aviso por revisión nueva con enlace a **su** revisión; línea base inicial sin avisos históricos (un solo resumen); sin repetición entre ciclos de polling; la resuelta desaparece; el cambio de usuario limpia; con la pestaña oculta no consulta; sin alertas funciona; vencimientos solo en la campana; los toasts rutinarios no entran al panel. Polling de 30–60 s con una sola instancia compartida; no hay sistema paralelo. Las claves anunciadas viven en `sessionStorage` por usuario (al cerrar la pestaña se muestra de nuevo un resumen, por diseño).
**Dependen aún del procesamiento programado (workflow 06, sin tocar):** las alertas persistentes `/alerts` (hoy 0), su estado de lectura y los avisos programados «vence en N días» como alertas del servidor.
**Sin prueba automática dedicada:** el cierre de sesión (`AuthCacheSync`) más allá del cambio de usuario, y la persistencia tras recargar (se apoya en `sessionStorage` y en la evidencia de navegador de la sección E).

### I.6 Carga y errores (Fase 5)
Sin reintentos automáticos de escrituras (`retry: false`). Subida bloqueada mientras sube; el servidor deduplica por SHA-256 (409). Aplicar es idempotente; decidir dos veces da 409. Los estados 400/401/409/415/429/500, servidor caído y espera larga se simularon en navegador (sección E) y se cubren en `messages.test.ts` y `Feedback.test.tsx`. El timeout de 60 s solo se probó con temporizadores simulados.

### I.7 Los ocho PDF (Fase 6)
Existen los 8 y **los SHA-256 coinciden con el inventario (8/8)**. Verificado de forma independiente: **pasan `acceptUpload('pdf')` y `PdfActiveContentScanner` reales del backend**; 1 página; texto seleccionable (`pdftotext`); importes del PDF = inventario (186.320; 58.900; 43.650; 99.900; 312.000; 64.250; 41.800; 85.500); fechas de emisión, vencimiento y período en 01–07; sin correos, NIT, cuentas ni teléfonos; todas con aviso de documento ficticio. La **08** declara «Fecha de emisión: (no indicada)», «Fecha límite de pago: —» y que no trae período. La 01 se revisó visualmente (aspecto de factura profesional). No se subieron al backend ni se enviaron por Gmail. No se probó la extracción con Gemini (no se consume).

### I.8 Pruebas automáticas finales (Fase 8)
| Verificación | Línea base | Final |
|---|---|---|
| Frontend `tsc -b` | OK | OK |
| Frontend oxlint | avisos | 0 errores (solo avisos react-refresh) |
| Frontend Vitest | 99/99 | **201/201** (17 archivos) |
| Frontend build | OK | OK |
| Backend `tsc --noEmit` | OK | OK |
| Backend unitarias | 582/582 | **586/586** (32 archivos) |
| Backend e2e (PGlite) | 609/609 (QA del 9-nov) | **613/613** (29 archivos) |
| Backend `nest build` | OK | OK |

### I.9 Estado de las e2e (Fase 7)
Ejecutadas: 613/613 sobre PGlite en memoria, sin tocar Neon, `backend/.env` ni ninguna base real. No ejecutadas: las pruebas contra PostgreSQL 18 real (`infra/qa`, contenedor `notihouse-qa-postgres` detenido) ni `test/pg/`. Para `appliedAt` se recomienda correrlas allí antes de desplegar: `to_char(… at time zone …)` y la subconsulta se probaron en PGlite, no en PostgreSQL 18 ni en Neon.

### I.10 Pendientes
**Bloqueantes:** ninguno para el commit.
**Importantes:**
1. Ejecutar la consulta de `appliedAt` en el PostgreSQL 18 de `infra/qa` antes de desplegar el backend.
2. Repaso visual humano del refactor y, con el backend desplegado, verificar en Render la transición real de `appliedAt`.
3. Probar los PDF 01–08 con Gemini real (requiere autorización de cuota).

**Menores:** los de la sección G; cierre de sesión y recarga de notificaciones cubiertos solo de forma indirecta; Git avisa de conversión LF→CRLF en 9 archivos (configuración de `core.autocrlf`, no del refactor).

### I.11 Qué requiere despliegue
- **Backend (Render):** sí, para `appliedAt` (`cases.service.ts`, `hitl.service.ts`, `process.dto.ts`). Sin migraciones.
- **Frontend (Vercel):** sí, para todo el refactor; funciona con el backend actual.
- **n8n y workflows:** no. **Neon:** sin cambios de esquema.

### I.12 Orden seguro de integración
1. Revisión humana del diff y commit en `develop` (sugeridos dos commits: backend `appliedAt`; frontend + docs).
2. Correr la consulta en la pila QA (PostgreSQL 18).
3. Desplegar **primero el backend** (campo opcional y aditivo; el frontend anterior lo ignora).
4. Verificar con lecturas que `GET /hitl-requests/:id` devuelve `proposal.appliedAt` (fecha en la propuesta ya aplicada de Aseo, `null` en una aprobada sin aplicar).
5. Desplegar el frontend (con el orden inverso también es seguro, pero no mostrará «Aplicada» hasta que el backend lo exponga).
6. Solo después, con autorización: activar el workflow 06 y probar PDF con Gemini.

### I.13 Estado final de Git
Rama `develop`; **sin commit ni push**; nada borrado. Cambios de esta auditoría: `backend/src/cases/cases.service.ts`, `backend/src/cases/dto/process.dto.ts`, `backend/src/cases/proposal-read-columns.spec.ts`, `backend/test/proposal-application.e2e-spec.ts`, `frontend/src/lib/api/{client,errors,messages}.ts`, `frontend/src/lib/api/messages.test.ts` y este informe.


---

## J. Archivado manual y mediante IA: implementación y verificación

**Veredicto de esta ampliación: LISTO CON OBSERVACIONES.** Implementado en código y probado en local (PGlite) y en QA aislado (PostgreSQL 18.6 + n8n real con Gemini **simulado**). **No se usó Gemini real** (0 de 8 llamadas): la clave solo existe cifrada dentro del n8n operativo y no se extrajo. **Nada está desplegado ni verificado en producción.**

### J.1 Qué existía antes
- Estado `archived` en el enum de obligaciones y `PATCH /obligations/:id` con `status` (sin confirmación, sin conteo de pendientes, sin regla propia). Una obligación archivada rechazaba ediciones (409) y nuevos períodos (409); la recurrencia solo genera para `active`.
- El asistente solo conocía 7 intenciones (sin archivar). `needs_choice` mostraba alternativas, pero elegir una **solo registraba la elección** (limitación A-7: no continuaba el caso).

### J.2 Qué se implementó
**Una sola regla de negocio** (`ObligationsService.archiveLocked`): bloquea la fila, 409 si ya estaba archivada, cambia solo `status`, cuenta los períodos pendientes/vencidos, audita (`obligation.archive`, con `via: manual|proposal` y `periodsModified: false`). La usan tres entradas:
1. **Manual:** `POST /obligations/:id/archive` (nuevo; devuelve la obligación y `pendingOccurrences`). `PATCH {status:'archived'}` ahora delega en la misma regla y no admite mezclar otros campos.
2. **IA + HITL:** nueva acción `archive_obligation` (datos `obligationId` + `expected {providerName, concept}` para control optimista). Se aplica con `POST /cases/:id/proposals/:id/apply`, tras aprobar.
3. **Continuación A-7** (ver J.5).

**Migración 0005** (`ALTER TYPE proposal_application_action ADD VALUE 'archive_obligation'`): aditiva, mismo patrón que la 0004. **Probada en PostgreSQL 18.6** (6 migraciones aplicadas) y en PGlite. **No se aplicó a Neon.**

**Política con períodos pendientes (conservadora, sin cambios retroactivos):** archivar detiene la recurrencia, pero los períodos `pending/overdue` no se anulan, no se marcan pagados ni cambian de importe. Siguen visibles en Bandeja, alertas y vencimientos (no filtran por estado de obligación) y se pueden confirmar o editar (e2e). Los importes y pagos históricos no se tocan. No hay borrado físico.

### J.3 Frontend (sin cambiar la identidad visual)
- Botón **«Archivar obligación»** en el detalle y modal de confirmación («¿Quieres archivar esta obligación?», con aviso del número de períodos pendientes), `LoadingButton`, bloqueo síncrono de doble clic (`ref`), 409 → «ya estaba archivada», tiempo agotado → consulta el estado real antes de sugerir reintentar. Obligación archivada: aviso en el detalle, sin acciones de edición y con «Generación automática: Detenida». El filtro de estado de la lista ya existía y muestra «Archivada».
- HITL: la propuesta `archive_obligation` muestra proveedor, concepto, qué se conserva y la advertencia de períodos pendientes; mismo flujo Aprobar → Aplicar con `appliedAt`.
- Notificaciones: archivar invalida Bandeja/Resumen/listas; **no** crea una notificación persistente («Obligación archivada correctamente» es un toast). La campana sigue mostrando los pendientes que continúan.
- Accesibilidad: el componente compartido `Modal` ahora **devuelve el foco** al botón que lo abrió (antes lo perdía en `<body>`).

### J.4 Asistente (IA) y n8n
- Nueva intención `archive_obligation` en el esquema de extracción, en el prompt (jamás es borrado; la IA no elige la obligación) y en el resolvedor determinístico. Identificación por proveedor, concepto o categoría ("el internet") **solo entre obligaciones del propietario**; una sola coincidencia → propuesta; varias → `needs_choice`; ninguna → pide completar; ya archivada → informativo; mensaje con instrucciones (R16) → no aplicable; documentos no pueden producir esta intención (A-5).
- **Workflow 04 versionado** (`n8n/workflows/04-procesamiento-voz.json`, 3 líneas): intención y prompt, lista de intenciones del nodo «Construir propuesta» y reenvío de `continuation` en el contexto de la revisión (solo intenciones conocidas y parámetros acotados). **Workflows 02, 03, 05, 05b y 06: sin cambios.** Las 7 intenciones anteriores no cambian de formato.

### J.5 A-7 — Desambiguación y continuación (archivar y modificar)
**Causa original:** `decide()` solo guardaba `choice`; nada construía una propuesta con la alternativa elegida y el flujo se cerraba como «elección registrada».
**Solución determinística en el backend** (sin Gemini ni n8n en la continuación): `resolve` devuelve `continuation {intent, params}` junto a las alternativas (con proveedor, concepto, inmueble e **importe**; nunca UUID visible). n8n la copia a `options.context.continuation`. Al **aprobar la elección** (`POST /hitl-requests/:id/decision {choice}`), el backend:
1. comprueba que la clave fue ofrecida (400 si no) y que es un UUID;
2. vuelve a leer la obligación con `owner_id` del usuario autenticado y estado no archivado (409 si ya no está disponible);
3. construye la propuesta con la **misma función** que el resolvedor (`buildScheduleChange` / archivar), la valida con el parser estricto de acciones y la guarda (`source: user`);
4. crea **una** revisión de aprobación (`data_confirmation`) con advertencias y consecuencias, deja el caso en `awaiting_human` y registra `followUpRequestId`;
5. no encola el cierre (el workflow 03 cierra el caso solo tras la segunda decisión).
Repetir la misma elección devuelve lo mismo sin duplicar; otra alternativa → 409. **Frontend:** «Continuar con la seleccionada» (o error «Elige una alternativa»), y navega automáticamente a la nueva revisión. Se aplica igual a **modificar** (`update_obligation_schedule`, con valores «ahora/propuesto») y a **archivar**. Sin migraciones adicionales: se reutiliza `hitl_requests.options.context`.
**Compatibilidad:** una revisión de elección sin `continuation` conserva el comportamiento anterior (solo registra); cubierto por e2e.

### J.6 Pruebas y resultados
| Verificación | Resultado |
|---|---|
| Backend `tsc`, `oxlint` (0 errores), build | OK |
| Backend unitarias | **587/587** |
| Backend e2e (PGlite) | **645/645** (613 previas + 32 nuevas de archivado/A-7) |
| Frontend `tsc`, `oxlint` (0 errores), build | OK |
| Frontend Vitest | **214/214** (201 previas + 7 de archivado manual + 6 de HITL/selector) |
| n8n pruebas estáticas | 107/107 |
| QA real (PostgreSQL 18.6, backend QA, **n8n 04 y 03 reales**, Gemini simulado) — `run-all` | e01–e11, e12 y e09 sin regresiones (02/03/04 con intenciones anteriores, voz, PDF, Gmail simulado, kill switches); **e13 nuevo: 37/37** |
| Navegador (QA, Chromium) | selector de alternativas, propuesta de archivado, aprobar→aplicar→recarga sin «Aplicar», obligación archivada, modal en móvil (390 px) y teclado; 0 errores de consola; sin desborde horizontal |

Casos cubiertos en e2e/QA: archivar activa; ya archivada (409); inexistente y ajena (404); doble clic simultáneo (1 éxito, 2×409); con períodos pagados y pendientes; recurrencia detenida; PATCH con campos mezclados; IA: solicitud clara, ambigua con 3 coincidencias, inexistente, ya archivada, otro usuario, instrucciones incrustadas; aprobar sin aplicar; aplicación duplicada; propuesta rechazada; obligación renombrada o archivada entre aprobación y aplicación (409); campos prohibidos (`status`) y acciones inexistentes (`delete_obligation`) rechazados con kill switch; selección manipulada (clave no ofrecida → 400; clave ofrecida pero de otro usuario → 409 y sin cambios); alternativa archivada antes de elegir; elección repetida; elección rechazada; usuario ajeno decidiendo (404).

**`appliedAt` en PostgreSQL 18.6 (pendiente del informe anterior):** aplicadas → fecha ISO UTC; no aplicadas → `null`; la subconsulta acotada a `case_proposals.id` funciona. Comprobado vía API sobre el backend QA.

### J.7 Escenarios del requisito A-7 (QA real, e13)
- **A (modificar, ambiguo)** «Cambia el vencimiento del internet al día 20»: 2+ alternativas → selección → propuesta «día 15 → 20» solo para la elegida → aprobar (no cambia) → aplicar (solo esa pasa al 20; la otra conserva el 15; auditoría solo de la elegida; caso cerrado por el workflow 03).
- **B (archivar, ambiguo)** «Quiero eliminar el internet»: alternativas con importe → selección → propuesta de archivado con advertencia de 1 período pendiente → aprobar → aplicar → solo la elegida archivada, otra activa, períodos intactos, 1 auditoría, 1 sola revisión de aprobación, caso `completed`.
- **C (sin ambigüedad):** propuesta directa sin pasos extra; ya archivada → informativo; inexistente → sin propuesta.
- **D (seguridad):** alternativas nunca incluyen obligaciones ajenas; clave ajena → 400; otro usuario → 404.

### J.8 Lo que NO está probado / limitaciones
- **Gemini real: 0 llamadas.** El prompt y esquema con `archive_obligation` solo se validaron con el extractor simulado y con las verificaciones deterministas del workflow (anclaje, R16). No se afirma que Gemini real clasifique «elimina el internet» como archivado.
- No se ejecutó `test/pg/` (suite de concurrencia sobre `infra/testing`) ni lector de pantalla ni axe. Contrastes no medidos.
- El recorrido visual de esta ampliación cubre el selector, la propuesta, el detalle archivado y el modal; no se repitió el de Resumen, Bandeja, Documentos y demás pantallas (siguen valiendo las evidencias de la sección E).
- Observaciones menores: al continuar, el aviso flotante «Tienes una propuesta por revisar» aparece unos instantes aunque ya estés en esa revisión; el texto de la propuesta de archivado repite tres veces que se conserva el historial. Con un proveedor dado, el concepto no se usa para descartar candidatas.
- El archivado de contratos, inmuebles y arriendos no se tocó.

### J.9 n8n operativo (puerto 5678): auditoría y decisión
- Respaldo de lectura exportado (10 workflows, sin secretos) en `C:\Users\eliza\AppData\Local\Temp\claude\67657703d21b50a6\7df6ac7b-a4ec-4927-9d0b-b0266a3b53b0\scratchpad\n8n-operativo-backup\operativo-workflows-2026-11-11.json` (carpeta temporal: **cópialo a un lugar permanente fuera de OneDrive**), y copia del 04 previo a A-7 (`04-procesamiento-voz.BACKUP-before-A7.json`, mismo directorio padre).
- Estados verificados: **02, 03 y 04 activos; 01, 04b, 05, 05b, 06 y los dos temporales inactivos.** No se importó, activó, pausó ni modificó nada en el n8n operativo.
- **No se actualizó el 04 operativo, a propósito:** el backend de Render no tiene la migración 0005 ni la intención; un 04 nuevo enviaría `archive_obligation` a un backend que la rechaza (400) y los textos con esa intención fallarían. La versión validada queda en el repositorio lista para importar **después** del despliegue.

### J.10 Qué requiere despliegue y orden seguro
1. Revisión humana y commits en `develop` (sugerido: backend+migración; frontend; n8n+QA+docs).
2. **Aplicar la migración 0005 a Neon con autorización** (aditiva: solo agrega un valor al enum; no bloquea lecturas). Respaldo/branch de Neon antes.
3. Desplegar el **backend** (Render): `appliedAt`, archivado, `archive_obligation`, continuación A-7.
4. Verificar con lecturas: `GET /hitl-requests/:id` trae `proposal.appliedAt`; `POST /obligations/:id/archive` responde 401 sin token.
5. Desplegar el **frontend** (Vercel). Con backend anterior el frontend nuevo degrada con seguridad (sin «Aplicar» falso), pero el botón de archivar daría 404 hasta el paso 3.
6. Exportar de nuevo el 04 operativo (respaldo), importar la versión del repositorio con `n8n/tools/import-workflow.mjs` (sin `--qa-*`), comprobar credenciales y conservar 02/03/04 activos y 05/05b/06 inactivos.
7. Con autorización: probar con Gemini real (≤ 8 llamadas) «Quiero eliminar el internet» y «Cambia el vencimiento del internet al día 20» con datos ficticios en una cuenta de prueba.

### J.11 Estado de Git
`develop`, **sin commit ni push**. Modificados: 62; nuevos: 37 (incluye `database/migrations/0005_archive_obligation_action.sql` y su snapshot, `backend/test/archive-obligation.e2e-spec.ts`, `infra/qa/scenarios/e13-…`, componentes y pruebas del frontend). Escaneo de secretos del diff y de archivos nuevos: sin hallazgos (el único aviso es el propio texto de este informe). Archivos temporales de QA (sesiones, capturas, registros) están bajo `.local/` (ignorado) y el token de sesión de navegador se eliminó. La pila QA sigue en ejecución (Docker `notihouse-qa-*`, backend 3100, Gemini simulado 3200, Vite 5174); no se detuvo.

### J.12 Veredicto consolidado
| Dimensión | Estado |
|---|---|
| Código implementado | Sí (archivado manual, archivado con IA, modificación y archivado con desambiguación A-7) |
| Pruebas locales (PGlite, Vitest) | Aprobadas |
| QA aislado (PostgreSQL 18 + n8n real + Gemini simulado) | Aprobado (e13 37/37 y regresión previa completa) |
| Gemini real | **No probado (0/8)** |
| n8n operativo | Sin cambios (respaldado; versión nueva lista para importar tras desplegar) |
| Desplegado / en producción | **Pendiente**; nada verificado en producción |

**LISTO CON OBSERVACIONES** para commit y revisión de integración. Observaciones principales: Gemini real sin probar, migración 0005 pendiente en Neon y revisión visual humana del resto de pantallas.
---

## K. Cierre QA y preparación de demo — 14 de noviembre

> Alcance de esta sección: estabilización. **No se añadió ninguna funcionalidad de negocio ni se rediseñó nada.** Se corrigieron únicamente defectos reproducibles. Todo lo que usa Gemini en QA es **Gemini simulado**; no se hizo ninguna llamada a Gemini real (0 de 8). No hubo commit, push, despliegue, migración en Neon ni cambios en el n8n operativo.

### K.1 Estado real al empezar (Fase 0)

| Comprobación | Resultado |
|---|---|
| Git | `develop`, sin commit ni push; 63 modificados y 34 sin seguimiento (ver K.11) |
| QA aislado | PostgreSQL 18.6 en `127.0.0.1:55433` (base `notihouse_qa`), n8n QA 5679, backend 3100, Gemini simulado 3200, Vite 5174: todos arriba |
| Aislamiento de escrituras | `qa.env` no define `DATABASE_URL`; `start-backend.mjs` construye el entorno desde cero y **rechaza** cualquier destino distinto de `127.0.0.1:55433`; `reset-qa.mjs` también. Sin cadenas de Neon en el diff ni en archivos nuevos |
| n8n operativo (`notihouse-n8n`, 5678) | No se tocó. Solo se comprobó que el contenedor sigue arriba |
| Secretos / archivos de sesión | Búsqueda en diff y archivos nuevos (claves de API, JWT, PEM, `client_secret`, `refresh_token`, `neon.tech`): sin hallazgos. `.local/` está ignorado. Se eliminaron los tres PNG que dejaron mis capturas en la raíz y el servidor efímero de sesión |
| Respaldo del n8n operativo | **Copiado fuera de la carpeta temporal y de OneDrive:** `C:\Users\eliza\notihouse-backups\n8n-operativo-20261111-pre-archivado\` (`operativo-workflows-2026-11-11.json`, 10 workflows legibles, y `04-procesamiento-voz.BACKUP-before-A7.json`) |

### K.2 Auditoría de errores de Gemini y n8n (Fase 1.1 y 1.3)

Cómo se vio cada situación: «QA» = escenario `e14-errores-ia.mjs` (nuevo; n8n 04/03 reales + Gemini simulado, con modos nuevos `invalid_json`, `empty` y `hang` en `mock-gemini.mjs`); «Nav.» = navegador contra el frontend QA con red simulada con Playwright; «Unit.» = Vitest.

| # | Situación | Qué ocurre de verdad | Qué ve la persona | Evidencia |
|---|---|---|---|---|
| 1 | Gemini 429 (una vez) | n8n reintenta; el trabajo se completa en el 2.º intento | «Estamos procesando…» y luego la propuesta | QA e14 |
| 2 | Gemini 429 persistente (cuota diaria) | 1.er fallo: el trabajo vuelve a la cola con espera, el caso sigue «procesando». Tras 5 intentos: caso **fallido** | «No pudimos completar el análisis. El asistente no está disponible en este momento. Revisa el estado de tu solicitud antes de volver a intentarlo» + botón «Volver a intentarlo» | QA e14, Nav. (captura), Unit. |
| 3 | Gemini 500 / 503 (una vez y persistente) | Igual que 1 y 2 | Igual que 1 y 2 | QA e14 |
| 4 | Tiempo de espera de Gemini (`hang`) | **No ejecutado en vivo**: n8n espera 120 s por intento con 5 intentos (>10 min por ejecución). El modo `hang` existe en el simulador | Frontend: aviso de «sigue procesándose» tras 90 s (Nav.); el cierre definitivo es el de 2 | Unit. + Nav. (parcial) |
| 5 | JSON inválido de la IA | Se reintenta; si persiste, caso fallido **sin propuesta** | Mensaje del punto 2; nunca JSON ni nombres de modelo | QA e14 |
| 6 | Respuesta vacía de la IA | Igual que 5 | Igual que 5 | QA e14 |
| 7 | Intención desconocida de la IA | El backend la descarta: **sin propuesta aplicable** | Revisión informativa, sin acciones aplicables | QA e14 |
| 8 | Mensaje no comprendido | `unsupported`: sin propuesta aplicable | Se pide aclarar/gestionar manualmente | QA e14 |
| 9 | El backend deja de responder | — | Lecturas: «No pudimos cargar esto. No pudimos conectar con el servicio…» + **Reintentar**. Envío: mismo mensaje + «revisa Mis solicitudes antes de repetirlo»; el texto escrito se conserva y el botón queda habilitado | Nav. (se detuvo el backend QA de verdad) |
| 10 | n8n no reclama el trabajo | El caso queda «recibido» | «En cola: se procesará en unos instantes»; a los 90 s «Tu solicitud sigue procesándose… puedes seguir usando NotiHouse-Pal». **No** se muestra fallo ni pérdida | Nav. (95 s reales), Unit. |
| 11 | n8n marca el trabajo como fallido (reintentos agotados) | Caso fallido, trabajo `failed/5` | Mensaje del punto 2 | QA e14, Nav. |
| 12 | La persona pierde conexión | `TypeError` del navegador | «No pudimos conectar con el servicio. Comprueba tu conexión e inténtalo nuevamente.» (+ aviso de comprobar antes de repetir si fue una escritura) | Nav., Unit. |
| 13 | Registrado en el servidor, el navegador no recibe respuesta | El servidor guarda y la conexión se corta | Mensaje de 12 con la indicación de revisar «Mis solicitudes». Al reenviar el mismo texto se reutiliza el mismo `requestId`: **una sola solicitud** (verificado en la base QA: 2 envíos → 1 trabajo) | Nav. + base QA, Unit. |
| 14 | Doble envío | — | Un solo envío mientras uno está en curso; el botón muestra «Enviando…» | Unit., Nav. |
| 15 | 503 / 500 con texto técnico del servidor | — | «El servicio está iniciando o no está disponible por ahora…» / «El servidor tuvo un problema…»; **nada** de «TypeError», rutas ni JSON | Nav. (cuerpo técnico simulado), Unit. |

Hallazgo de comportamiento (no es un defecto): tres fallos técnicos definitivos seguidos activan el **kill switch** `text_processing`, que protege la cuota; e14 lo reanuda al terminar. Con el kill switch activo, el envío puede responder 503 con el mensaje de servicio no disponible.

### K.3 Defectos encontrados y corregidos (solo reproducibles)

| # | Defecto | Cómo se reprodujo | Corrección | Prueba |
|---|---|---|---|---|
| 1 | **Reintentar tras un timeout duplicaba la solicitud**: cada clic generaba un `requestId` nuevo y anulaba la idempotencia del backend | Navegador: respuesta cortada tras guardar → reintento | `lib/requestKey.ts`: mismo `requestId` mientras el contenido sea el mismo; se renueva al confirmarse o cambiar el contenido. Usado en texto, voz y PDF | 3 + 5 tests nuevos; navegador: 2 envíos → 1 trabajo |
| 2 | **Texto técnico del backend mostrado tal cual**: al agotar reintentos el caso trae `La automatización "text.interpret" falló de forma definitiva` y la pantalla lo habría enseñado | QA e14 (persistente) | `friendlyReason` lo traduce al mensaje claro; la causa técnica sigue en el backend | Unit. (con el texto real) |
| 3 | Mensajes de fallo hablaban de «documento» aunque fuera un mensaje o nota de voz; faltaba el mensaje de «asistente no disponible» | Revisión de `caseProgress` | `friendlyReason(reason, source)`: según origen; 6 causas de IA traducidas | Unit. (7 casos sin tecnicismos) |
| 4 | Un caso fallido no ofrecía ninguna acción | Captura del caso fallido en QA | Tarjeta «puedes enviarla de nuevo sin riesgo de duplicar datos» + «Volver a intentarlo» / «Subir otra factura» | Unit. + captura |
| 5 | Mensaje de red distinto del pedido y sin aviso para escrituras | Revisión | «No pudimos conectar con el servicio. Comprueba tu conexión e inténtalo nuevamente.» + indicación de comprobar si fue una escritura | Unit. |
| 6 | El 429 de «Ya tienes 3 mensajes en proceso…» se reemplazaba por un texto genérico | Revisión | Se conserva la frase clara del backend | Unit. |
| 7 | **Aviso flotante redundante** «Tienes una propuesta por revisar» al continuar a la revisión nueva tras elegir una alternativa | Observación previa (J.8) | `NotificationToaster` espera 700 ms y vuelve a comprobar la ruta | Unit. (la campana sí conserva el aviso) |
| 8 | Enlaces «Ver» de tablas de 23×17 px en móvil (mínimo WCAG 2.2: 24×24) | Medición en navegador a 390 px | Zona táctil de 24 px sin mover el diseño | Navegador: 0 objetivos pequeños |
| 9 | No existía enlace «Saltar al contenido» (15 tabulaciones de menú antes del contenido) | Recorrido con teclado | Enlace visible solo con foco; `main` enfocable | Navegador: 1.er Tab = «Saltar al contenido» |

Limitación: la prueba del punto 7 se escribió y pasa, pero **no se ejecutó en rojo sin la corrección** (no hice el ciclo rojo-verde).

### K.4 Regresión funcional de los 14 bloques

Datos siempre ficticios. «Gemini»: Simulado (QA) / Ninguno. «Modifica»: datos de la base QA desechable.

| # | Área | Usuario | Acciones y evidencia | Estado | Gemini | Modifica | Repetible en la sustentación |
|---|---|---|---|---|---|---|---|
| 1 | Autenticación | Daniel, Laura, Andrés (QA) | Login, 401, límite de intentos, aislamiento entre usuarios (e09); sesiones y rutas protegidas (Vitest). En el navegador la sesión se inyectó; **el formulario de login no se repitió en navegador en esta ronda** | Aprobado (automático) | Ninguno | No | Sí |
| 2 | Navegación y UX | Andrés | Recorrido de 11 pantallas en escritorio y 7 a 390 px: 0 errores de consola, 0 respuestas HTTP ≥ 400, sin desbordes horizontales, sin «undefined/NaN/null» ni importes tipo `87400.00` | Aprobado | Ninguno | No | Sí |
| 3 | Obligaciones manuales | Laura/Andrés | Crear, editar, períodos, recurrencia y conservación de fechas (e05, e01, e2e); formularios de dinero (Vitest) | Aprobado | Ninguno | Sí (QA) | Sí |
| 4 | Archivado manual | Laura | Confirmación, períodos pendientes conservados, recurrencia detenida, sin borrado físico (ArchiveFlow 7 tests, e2e 32). Navegador visto en la ronda anterior (J.3); no repetido hoy | Aprobado (automático) | Ninguno | Sí | Con otra obligación |
| 5 | Asistente normal | Andrés | Texto → propuesta → persistencia (e01, e02); envío desde el navegador y seguimiento | Aprobado | Simulado | Sí | Sí |
| 6 | A-7 modificación | Andrés | Dos «internet», elección, solo la elegida cambia al día 20 (e13 A1–A10) | Aprobado | Simulado | Sí | Con otro par |
| 7 | A-7 archivado | Laura | Ambigüedad, elección, HITL, aplicación, historial y período pendiente intactos, 1 sola auditoría (e13 B1–B18, C, D) | Aprobado | Simulado | Sí | Con otro par |
| 8 | HITL | Daniel/Laura | Aprobar ≠ aplicar, `appliedAt`, rechazo, expiración, idempotencia (e07, e09, ArchiveHitl 6 tests) | Aprobado | Simulado | Sí | Sí |
| 9 | PDF frontend | Daniel | PDF válido/inválido/escaneado/con contenido activo (e04, DocumentsPage tests). Los 8 PDF de demostración se verificaron en la sección I | Aprobado | Simulado | Sí | Sí, con PDF nuevo |
| 10 | Gmail | Daniel | **Solo simulado** (e08: aislamiento, duplicados, propuesta). **No se ejecutó Gmail real** (requiere autorización y un mensaje único) | Aprobado simulado; real no ejecutado | Simulado | Sí | Solo con autorización |
| 11 | Voz | Daniel | Audio de prueba y transcripción simulada (e03). **El micrófono real no se probó** (el navegador de pruebas no lo tiene) | Parcial | Simulado | Sí | Solo con micrófono real verificado antes |
| 12 | Arriendos y contratos | Daniel | Arriendos: registro, cobros y confirmaciones (e06); formularios de arriendos y contratos (Vitest, e2e). Pantallas de ambos recorridas sin errores | Aprobado | Ninguno | Sí | Sí |
| 13 | Notificaciones | Camila/Andrés (tests) | Campana («2 por atender»), avisos flotantes sin repetición, lectura, navegación, cambio de usuario sin restos y no redundancia (22 tests). Alcance real: **dentro de la aplicación**; no se asume Web Push/FCM. Workflow 06 no activado | Aprobado | Ninguno | No | Sí |
| 14 | Robustez y seguridad | Varias | Fallos de IA, red y n8n (e14), kill switches (e12), seguridad/concurrencia (e09), aislamiento por propietario (e13 D) | Aprobado | Simulado | Sí | No aplica (solo QA) |

### K.5 Resultados automáticos (ejecutados hoy)

| Suite | Resultado |
|---|---|
| Backend `tsc --noEmit` | Sin errores |
| Backend oxlint | 0 errores (1 advertencia antigua, `validators.ts`) |
| Backend unitarias | **587/587** |
| Backend e2e (PGlite en memoria) | **645/645** |
| Frontend `tsc -b` | Sin errores |
| Frontend oxlint | 0 errores (advertencias conocidas de librería/exports) |
| Frontend Vitest | **225/225** (antes 214: +11 nuevas) |
| Frontend build | Correcto |
| n8n validaciones estáticas | **107/107** |
| QA real (PostgreSQL 18.6 recién reiniciada + n8n 03/04 reales + Gemini simulado), 14 escenarios | **256 PASS, 0 FAIL** (e01 11, e02 14, e03 7, e04 14, e05 12, e06 8, e07 13, e08 12, e10 22, e11 21, e13 37, e14 22, e12 21, e09 42) |

No ejecutado: la suite `backend/test/pg/` contra una base real y el escenario de Gmail/voz con servicios reales.

### K.6 Navegador y accesibilidad

- **Hecho:** recorrido de 11 rutas (escritorio) y 7 (390 px) con captura de errores de consola, respuestas HTTP y excepciones de página: **0**. Los únicos errores de consola fueron los provocados a propósito en las pruebas de red (conexión cortada o backend apagado).
- **Auditoría de DOM (390 px):** 0 botones/enlaces sin nombre, 0 campos sin etiqueta, 0 ids duplicados, 0 imágenes sin `alt`, un `h1` por página, `lang="es"`, un `main` por página.
- **Teclado:** orden lógico (menú → cabecera → contenido), foco visible en todos los elementos recorridos, enlace «Saltar al contenido» (nuevo). La restauración del foco al cerrar un modal quedó resuelta en J.
- **Pendiente menor:** saltos de encabezado h1→h3 en Documentos y Alertas (no corregido: requiere tocar la jerarquía visual).
- **No ejecutado:** lector de pantalla real (NVDA/VoiceOver) y axe-core. Lo medido arriba es una auditoría propia del DOM, no una certificación de accesibilidad.

### K.7 Notificaciones

Alcance real: campana y avisos flotantes **dentro de la aplicación**, derivados de revisiones pendientes, Bandeja y alertas; no hay Web Push/FCM ni correo. Verificado: 22 tests (derivación, un solo aviso por evento aunque el polling lo vea varias veces, resumen único al iniciar sesión, cambio de usuario sin restos, fallo de red sin pánico) y el nuevo caso de no redundancia. En QA la campana mostró «2 por atender». No se activó el workflow 06.

### K.8 A-7 y archivado

e13 repetido sobre base limpia: **37/37**. La obligación no elegida queda intacta con sus períodos; no existe borrado físico; la elegida conserva el historial y el período pendiente; aplicar dos veces no duplica la auditoría. Selección duplicada y reintento tras timeout: cubiertos por la clave de idempotencia (K.3 #1) y por el 409 «ya decidida» del backend (e2e).

### K.9 Compatibilidad de la migración 0005

La migración es aditiva (`ALTER TYPE … ADD VALUE 'archive_obligation'`). Hoy se aplicó desde cero junto con las anteriores en la PostgreSQL 18.6 de QA («Migraciones aplicadas: 6»). **No se aplicó en Neon.** El código anterior ignora un valor de enum que no usa; el nuevo backend la necesita. Hasta aplicarla, crear una propuesta de archivado falla en producción.

### K.10 Estado de los workflows

- Repositorio: solo cambió `04-procesamiento-voz.json` (3 líneas, ya descritas en J.4). 02, 03, 05, 05b y 06 sin cambios. Validaciones estáticas 107/107.
- n8n QA: 03 y 04 ejecutados de verdad en 14 escenarios.
- **n8n operativo: sin cambios.** 02, 03 y 04 activos; 01, 04b, 05, 05b, 06 y los dos temporales inactivos (comprobado en la auditoría previa; hoy no se modificó nada). El 04 nuevo **no** está importado (ver K.13, paso 8).
- Respaldo permanente: ver K.1.

### K.11 Estado de Git

`develop`, **sin commit ni push**. 63 archivos modificados (+1.841 / −476) y 34 sin seguimiento. Nuevos de esta ronda: `frontend/src/lib/requestKey.ts` y su test, `frontend/src/features/assistant/AssistantPage.test.tsx`, `infra/qa/scenarios/e14-errores-ia.mjs`; modificados: `AssistantPage`, `DocumentsPage`, `caseProgress` (+test), `CaseDetailPage`, `CaseFlow.test`, `messages` (+test), `NotificationToaster` (+test), `AppShell`, `tokens.css`, `mock-gemini.mjs`, `run-all.mjs`. El backend no cambió en esta ronda.

### K.12 Bloqueantes reales y observaciones

**Bloqueantes para la integración (requieren tu autorización):** commit/push; migración 0005 en Neon; despliegue de Render y luego Vercel; importar el 04 nuevo al n8n operativo; **prueba con Gemini real (0/8 usadas)**. Hasta entonces no puede afirmarse que Gemini real clasifique «Quiero eliminar el internet» como archivado ni que cumpla el formato de respuesta esperado.

**Observaciones:** cuota gratuita de Gemini de 20 peticiones/día (riesgo para ensayos el mismo día); micrófono real, Gmail real, lector de pantalla/axe y la suite `test/pg` sin ejecutar; el timeout largo de Gemini (fila 4 de K.2) no se ejecutó en vivo; la prueba del aviso no redundante no se vio fallar sin la corrección; encabezados h1→h3 en dos pantallas; texto repetido en la propuesta de archivado (menor).


### K.13 Orden de despliegue (preparado, **no ejecutado**)

Cada paso que escribe en un servicio compartido está marcado con ⚠ y espera tu autorización expresa. Los comandos son los documentados en `docs/deployment/mvp-demo-setup.md` (Auto-Deploy de Render está desactivado: el despliegue es manual).

| # | Paso | Comando / acción | ¿Escribe en producción? |
|---|---|---|---|
| 0 | Revisar el diff y las pruebas de esta sección | `git status`, `git diff --stat` | No |
| 1 | Respaldos recuperables | Copia del n8n operativo ya guardada fuera de OneDrive (K.10). Antes de la migración: *branch*/punto de restauración de Neon desde el panel de Neon | No |
| 2 | Validar la migración 0005 | Ya aprobada en PostgreSQL 18.6 de QA (K.9). `cd backend && npx drizzle-kit check` | No |
| 3 | ⚠ Commit y push de `develop` | Tres commits sugeridos: (a) backend + migración 0005; (b) frontend; (c) n8n + QA + docs. **No hecho** | Repositorio |
| 4 | ⚠ Migración 0005 en Neon | `cd backend && npm run db:migrate` con `DATABASE_URL_DIRECT` de Neon en tu equipo (nunca en Render). Es aditiva (`ALTER TYPE … ADD VALUE`); luego `npm run db:check` | **Sí (Neon)** |
| 5 | ⚠ Backend en Render | *Manual Deploy → Deploy latest commit*; esperar `GET /api/v1/health` y `/health/ready` = 200 | **Sí (Render)** |
| 6 | Verificación de lectura del backend | `GET /api/v1/hitl-requests/:id` incluye `proposal.appliedAt`; `POST /obligations/:id/archive` sin token responde 401 | No escribe |
| 7 | ⚠ Frontend en Vercel | Despliegue desde `develop`; `VITE_API_BASE_URL` apunta a Render. **Después** del paso 5 | **Sí (Vercel)** |
| 8 | ⚠ Workflow 04 en el n8n operativo | Exportar de nuevo el 04 actual (respaldo), importar `n8n/workflows/04-procesamiento-voz.json` con `n8n/tools/import-workflow.mjs` **sin** `--qa-*`, comprobar credenciales y que 02/03/04 queden activos y 05/05b/06 inactivos. **Solo con el backend nuevo ya desplegado** | **Sí (n8n local)** |
| 9 | Pruebas de humo reales | Lista en K.14 (marcadas ⚠ cuando consumen Gemini real o modifican datos de demo) | Datos de demo |

Reversa: Render → *Events → Rollback*; Vercel → *Promote* del despliegue anterior; n8n → importar `04-procesamiento-voz.BACKUP-before-A7.json` desde la copia permanente. La migración 0005 no se revierte (un valor de enum añadido no estorba al código anterior).

Regla de seguridad para el paso 8: si el 04 nuevo estuviera activo contra un backend que no reconoce `archive_obligation`, una solicitud de archivado recibiría un 400 al crear la propuesta. Por eso el 04 nuevo **no** se importa antes de los pasos 4–5.

### K.14 Plan de demostración (a verificar en el entorno desplegado)

Nada de lo siguiente se ha comprobado con Gemini real; los resultados de QA usan Gemini simulado.

**Antes de entrar (todo en el entorno desplegado, con la cuenta de demostración):**
1. Despertar Render (`/health`, `/health/ready`) y comprobar el kill switch (`/system/status`: ningún alcance activo).
2. Comprobar la cuota de Gemini: el nivel gratuito tiene 20 peticiones/día y cada prueba cuenta. Reservar al menos 6 para el día de la sustentación y **no** hacer ensayos completos ese día.
3. Dos obligaciones ficticias de internet para el caso difícil (p. ej. «Internet Hogar Uno» e «Internet Hogar Dos», importes distintos) y una obligación única para el caso normal.
4. n8n operativo encendido (02/03/04 activos) y el sondeo de Gemini del workflow 01/02 ejecutado una vez, ⚠ consume 1 petición.

**Caso normal (en vivo):** *«Cambia el aviso de la obligación de Claro a 5 días antes»* (una sola coincidencia).
Resultado verificable: el asistente crea la solicitud → aparece la revisión con la propuesta (antes → después) → **Aprobar** (no cambia nada) → **Aplicar** → el detalle de la obligación muestra «Aviso: 5 día(s) antes» y la solicitud pasa a «Cerrado · propuesta aplicada». Repetible: sí, volviendo el aviso a su valor original.

**Caso difícil (en vivo):** *«Quiero eliminar el internet»* (dos coincidencias).
Resultado verificable: el asistente **no elige**; pide escoger entre las dos alternativas (proveedor, concepto, importe) → «Continuar con la seleccionada» → nueva revisión «Archivar obligación de …» con la advertencia de períodos pendientes → Aprobar → Aplicar → solo la elegida queda «Archivada» y la otra sigue activa con sus períodos. Repetible: no sobre la misma obligación (queda archivada); crear otra pareja de obligaciones para cada ensayo.

**Si Gemini falla durante la demostración:** la propia aplicación explica «No pudimos completar el análisis. El asistente no está disponible en este momento…» y ofrece «Volver a intentarlo»; no se pierde nada. Es parte del guion de contingencia (K.15), no un fallo a ocultar.

**Pruebas de humo posteriores al despliegue:**

| Prueba | Gemini real | Modifica datos | Repetible |
|---|---|---|---|
| Inicio de sesión, Resumen, Bandeja, campana | No | No | Sí |
| Lectura de `appliedAt` en una revisión existente | No | No | Sí |
| Archivado **manual** de una obligación ficticia | No | Sí (ficticia) | Con otra obligación |
| Caso normal con IA | **Sí (≈1–2 llamadas)** | Sí | Sí, restaurando |
| Caso difícil con IA | **Sí (≈1–2 llamadas)** | Sí | Con otro par |
| Error de IA (simulado con el kill switch o cuota agotada) | No | No | Sí |

**Video complementario (recorrido, no en vivo):** Gmail supervisado (mensaje único con alias, sin reprocesar los anteriores; requiere autorización específica y OAuth vigente: en modo *Testing* el token vence a los 7 días), factura PDF → propuesta → aprobar y aplicar, Bandeja y Mis solicitudes, Arriendos, Contratos, campana de notificaciones y, solo si se verifica antes, nota de voz. **No grabar el video definitivo** con datos que las pruebas vayan a sobrescribir: primero congelar los datos de demostración.

### K.15 Contingencia y grabación de respaldo

- Grabar **por separado** los dos casos (normal y difícil) ya ejecutados con éxito en el entorno desplegado. Titular la grabación como «Grabación de respaldo» y presentarla como tal, nunca como ejecución en vivo.
- Orden de decisión durante la sustentación: (1) caso en vivo; (2) si la IA tarda más de ~90 s, la solicitud muestra «sigue procesándose» y se puede continuar con otra pantalla; (3) si falla, mostrar el mensaje de error de la aplicación (comportamiento verificado) y pasar a la grabación; (4) si Render está dormido, abrir `/health` un minuto antes.
- Con el kill switch activo, el envío puede responder 503 («El servicio está iniciando o no está disponible…»): el mensaje está verificado.

### K.16 Veredicto del cierre

| Criterio de cierre | Estado |
|---|---|
| Experiencia clara ante fallos de IA, red, backend y n8n | Cumplido en QA (K.2); 9 defectos corregidos (K.3) |
| Funcionalidades anteriores intactas | 14 escenarios QA reales 256/256; backend 587 + 645; frontend 225 |
| Archivado y A-7 con regresión | e13 37/37 sobre base limpia |
| Notificaciones según su alcance real | Aprobado (dentro de la aplicación) |
| Sin errores críticos de navegador | 0 errores de consola y 0 HTTP ≥ 400 en el recorrido normal |
| Despliegue preparado y ordenado | Sí (K.13), **sin ejecutar** |
| Demostraciones con resultado comprobable | Plan definido (K.14); **pendiente de verificar con Gemini real en el entorno desplegado** |
| Gemini real | **0/8: no probado** |

**LISTO CON OBSERVACIONES** para tu revisión y para autorizar la segunda etapa. No se hizo commit, push, despliegue, migración en Neon ni cambio en el n8n operativo.
