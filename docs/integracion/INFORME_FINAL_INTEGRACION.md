# Informe final de integración — rama `diego`

**Fecha:** 9-nov-2026 · **Sustentación:** sáb 14-nov-2026 · **Rama:** `diego` (no existe `develop/diego`; el resumen anterior usaba ese nombre por error) · **Base:** `develop` @ `819d724`.

> Este informe distingue siempre **qué se ejecutó** de **qué solo se inspeccionó**. Nada aquí afirma que Neon esté migrada, que Render esté desplegado ni que n8n, Gemini o Gmail hayan sido probados: no se tocó ninguno de ellos.

## 1. Resumen

La rama `diego` contiene el backend ampliado (recurrencia, acciones HITL nuevas, texto, resolución determinística, CORS, D6), las migraciones `0003` y `0004`, y el frontend disponible hoy. Tras la auditoría previa se corrigieron cinco hallazgos de backend y tres defectos de frontend, se verificaron las migraciones en **PostgreSQL 15.17 real desechable** y se probó un flujo completo contra un backend local con esa base.

## 2. Hallazgos de la auditoría y su corrección

| # | Hallazgo | Corrección | Evidencia ejecutada |
|---|---|---|---|
| 1 | `resolve` rechazaba trabajos de voz (403) | Lista **cerrada** `text.interpret` + `voice.transcribe`; `document.process` y demás siguen en 403. Sin relajar la verificación de reclamación (`jobId`, `claimToken`, caso del trabajo, vigencia, dueño del caso) | 3 pruebas e2e nuevas + flujo HTTP real (voz → 200, PDF → 403, claim inválido → 409) |
| 2 | D12: cambiar `dueDay` pisaba fechas de factura | Solo se recalculan los `pending` cuya fecha es la **prevista** por el día anterior; los de fecha propia se conservan (sin migración nueva; ver §6) | 1 prueba e2e nueva + flujo real (27-nov conservada; el período previsto pasó al día 22) |
| 3 | CORS aceptaba cualquier `http(s)` | `https` obligatorio salvo `http://localhost`, `127.0.0.1`, `[::1]`; comodines rechazados explícitamente (`https://*.vercel.app` pasaba `new URL`); origen ajeno sin cabeceras CORS y **sin 5xx** (antes `callback(Error)`) | 9 pruebas unitarias + 3 e2e (preflight permitido, preflight ajeno, GET ajeno) + `curl` real |
| 4 | Carrera del límite de 3 casos | `pg_advisory_xact_lock` por usuario antes del conteo | e2e (8 simultáneos → 3×201, 5×429; idempotencia simultánea) **y PostgreSQL real**: sin bloqueo 8 casos, con bloqueo 3 |
| 5 | `migrations.spec.ts` demasiado permisivo | Restaurado el patrón estricto; lista cerrada con solo las dos sentencias `DROP NOT NULL` de `proposal_applications` (0004) | 3 pruebas nuevas: cualquier otro `DROP` sigue fallando |
| 6 | Defecto frontend: revisión `update_obligation_schedule` mostraba «22 → 22» (usaba `expected` como propuesto) y omitía el aviso | Muestra `changes` | Verificado en navegador (22 → 25, 3 → 2) |
| 7 | Defecto frontend: tras «Aplicar» la pantalla seguía diciendo «aún no se ha creado nada» con el botón activo | Oculta mensaje y botón tras aplicar | Verificado en navegador |
| 8 | Defecto frontend: desborde horizontal en móvil (543 px a 390 px) | `min-width: 0` en `.app-body`/`.app-main` | Medido en 5 pantallas: sin desborde |
| – | Adicional: `update_occurrence_details` sin resumen en HITL; texto «de cada mes» inexacto para frecuencias no mensuales; 3 imports sin uso | Corregidos | tsc/lint |

## 3. Estado real del backend

**Implementado y verificado (aislado):** búsquedas `q`/`unassigned`; recurrencia automática (`POST /internal/recurrence/generate`); 6 acciones aplicables (2 originales + 4 nuevas); `POST /ingestions/text`; `POST /internal/cases/:id/assistant/resolve` (texto y voz); CORS con orígenes explícitos; D6 (aviso personalizado).

**No implementado:** N9 `POST /cases/:id/continuations` (opcional, A-7); N8 `GET …/upcoming` (recomendado); N2 `GET /ingestions/text/:caseId` (opcional); `q` en arriendos y contratos (N3b, opcional).

**Qué NO prueba el entorno aislado:** n8n, Gemini, Gmail, Neon (latencia, pooler, versión), PostgreSQL 17/18 (se usó 15.17), Docker (no estaba activo; la suite `conc:*` con PostgreSQL 18 **no se ejecutó**).

## 4. Estado real del frontend

Typecheck `tsc -b`: 0 errores · `oxlint`: 4 advertencias (react-refresh e incompatible-library, sin errores) · `vite build`: correcto (un chunk de 582 kB, sin code-splitting). **No existen pruebas automatizadas del frontend** (sin script `test` ni archivos de prueba).

**Verificado en navegador** (navegador automatizado con Playwright, backend local + PostgreSQL real, datos ficticios): landing; login; persistencia de sesión tras recarga completa; logout (limpia el almacenamiento) y redirección de rutas protegidas a `/login`; navegación; carga **sin errores 4xx/5xx de API** de Resumen, Bandeja, Inmuebles, Obligaciones, Arriendos, Contratos, Alertas, Documentos, Nota de voz, Mis solicitudes y Asistente; envío de texto por el asistente (201) y el aviso de 429 en pantalla; revisión HITL de `update_obligation_schedule` y `create_recurring_obligation` (aprobar → aplicar, con el mensaje de «aprobar no aplica»); vista móvil sin desborde.

**No verificado:** grabación de voz con micrófono real; subida de PDF y descarga desde la UI; formularios de alta/edición (Inmuebles, Obligaciones, Arriendos, Contratos) y confirmación de pagos/cobros desde la UI; pantalla de revisión de `create_recurring_rental` y `update_occurrence_details`; polling de la campana durante un minuto completo; pestañas en segundo plano; Safari/iOS y Firefox; accesibilidad; `conflict_resolution`/`target_selection` (no existe N9); integración real con n8n. Los DTO del frontend (`lib/api/types.ts`) no se compararon uno a uno con el backend: solo se comprobó que las pantallas listadas funcionan con respuestas reales.

## 5. Consolidación de ramas

| Rama | Relación con `diego` | Cambios exclusivos | Conflictos |
|---|---|---|---|
| `develop` | Ancestro: `diego` = `develop` + 16 commits | 0 | Ninguno (ver §9) |
| `main` | Ancestro lejano (`Initial commit`) | 0 | — |
| `feature/frontend-base` (`783002c`) | Incluida | 0 | — |
| `feature/frontend-landing` (`0e18467`) | Incluida | 0 | — |
| `feature/login-transition` (`5d5e4a4`) | Incluida (merge `875df19`) | 0 | — |

Se ejecutó `git fetch --all --prune`: **no existe ninguna otra rama remota** ni commits posteriores del compañero frontend. Por tanto **no había nada que integrar**; el frontend «estable disponible» es el de `login-transition` (landing, login, scaffold y capa de API/sesión) más el de Diego. Los cinco archivos de `login-transition` que Diego modificó son los puntos de coordinación: `frontend/index.html`, `src/app/RootRoute.tsx`, `src/app/router.tsx`, `src/features/dashboard/DashboardPage.tsx`, `src/lib/api/types.ts`.

**Para el compañero frontend:** si ya trabaja a partir de `login-transition`, sus cambios en esos cinco archivos y en `AppShell`/navegación pueden entrar en conflicto con los de Diego. Debe partir de `diego` (commit indicado en el informe del chat), no de `login-transition`, y coordinar antes de reemplazar pantallas ya hechas (resumen, bandeja, inmuebles, obligaciones, arriendos, contratos, alertas, documentos, voz, asistente, casos/HITL).

## 6. Decisiones técnicas y ambigüedades

- **D12 sin migración.** El esquema no distingue «fecha prevista» de «fecha propia». Se infiere comparando la `dueDate` del período `pending` con la que generaría el día habitual anterior. Limitación: una fecha de factura que coincida con la prevista se recalcula (efecto leve, el período sigue siendo `pending`). Alternativa descartada: columna `due_date_source` (migración adicional no justificada para el MVP). Si se prefiere una garantía total, es la opción a evaluar.
- **Límite de 3 casos** cuenta solo casos con trabajo `text.interpret` en `received`/`processing`. Mientras n8n no cierre casos (workflow 03), un usuario que envíe 3 mensajes queda bloqueado hasta que se cierren; es el comportamiento diseñado (D15).
- **CORS en producción** admite `http://localhost` por diseño (D18, frontend local contra la API real). Si se prefiere impedirlo en producción, quitar los orígenes locales de `FRONTEND_URL`.

## 7. Migraciones

| Archivo | PGlite | PostgreSQL real | Compatibilidad | Riesgo |
|---|---|---|---|---|
| `0003_auto_generate_recurrence` | ✅ | ✅ 15.17 | Aditiva. `auto_generate boolean NOT NULL DEFAULT false` en `obligations` y `rentals`; filas previas = `false`; el backend anterior la ignora | Bajo |
| `0004_proposal_actions_expansion` | ✅ | ✅ 15.17 | 4 valores nuevos de enum; `obligation_id` y `occurrence_id` pasan a nullable; `rental_id` con FK compuesta a `rentals(id, owner_id)`; CHECK «exactamente un recurso» | Medio (ver abajo) |

**Procedimiento ejecutado en PostgreSQL real** (clúster desechable en directorio temporal, `127.0.0.1`, puerto local, contraseña aleatoria; **destruido** al terminar, sin tocar otros contenedores ni volúmenes): `0000`–`0002` con el migrador de drizzle (`drizzle-orm/node-postgres/migrator`, el mismo mecanismo que `drizzle-kit migrate`); inserción de datos históricos ficticios (perfil, inmueble, obligación, período, arriendo, caso, propuesta, revisión y una aplicación); aplicación de `0003`+`0004` sobre esos datos. Resultados: 5 entradas en `drizzle.__drizzle_migrations`; filas históricas idénticas; `auto_generate = false` en todas; enum con 6 valores; columnas nullable; CHECK acepta obligación sola / arriendo solo y **rechaza** obligación+arriendo y ningún recurso; FK compuesta **rechaza** arriendo de otro dueño; las 4 uniques se conservan (incluida `occurrence_unique`, que rechaza un período repetido); una segunda ejecución del migrador no cambia nada (idempotente). `drizzle-kit check` correcto; journal y snapshots coherentes con el esquema Drizzle.

**Riesgos y límites:** (a) se probó en **PostgreSQL 15**, no 17/18 (versión de Neon: verificar); no se ejecutó la suite `conc:*` (Docker apagado). (b) Drizzle aplica los pendientes en **una sola transacción**: `ALTER TYPE … ADD VALUE` dentro de transacción es válido desde PostgreSQL 12 si los valores nuevos no se usan en el mismo lote (0004 no los usa; verificado). (c) **Difícil de revertir:** los valores de un enum no se pueden eliminar y volver a `NOT NULL` fallaría con filas nuevas; la recuperación debe ser una copia/rama de Neon previa. (d) El estado real aplicado en Neon **no se consultó ni se infiere**: debe verificarlo la responsable.

**Compatibilidad de despliegue:** el backend **anterior** de Render puede seguir funcionando tras migrar (cambios aditivos; solo una fila nueva de `proposal_applications` con recurso nulo no sería legible por él, y no puede crearla). El backend **nuevo** antes de migrar **fallará** en lecturas/escrituras de `obligations` y `rentals` (columna `auto_generate` inexistente). Orden: **migrar → desplegar**. Hacer merge no ejecuta migraciones.

## 8. Pruebas ejecutadas (esta sesión)

| Qué | Resultado |
|---|---|
| Backend unitarias (`vitest run`) | **582/582** (31 archivos) — antes 570 |
| Backend e2e (PGlite) | **609/609** (29 archivos) — antes 600 |
| Backend `tsc --noEmit` | 0 errores |
| Backend `oxlint` | 1 advertencia intencional (regex de caracteres de control) |
| `drizzle-kit check` | correcto |
| Migraciones en PostgreSQL 15.17 real | 15 comprobaciones, todas OK (§7) |
| Carrera del límite en PostgreSQL real | sin bloqueo 8 casos; con bloqueo 3 |
| Flujo HTTP real (backend local + PG real) | **30/30**: recurrencia (día 31, idempotencia, 4 barridos simultáneos, 401 sin token), texto, resolve (texto y voz), propuesta, HITL, aplicar sin aprobar → 409, aprobar no aplica, aplicar idempotente, `update_occurrence_details`, `update_obligation_schedule` (D12), `create_recurring_rental`, rechazo de `document.process`, ráfaga de 8 → 3 |
| Frontend `tsc -b` / `oxlint` / `vite build` | 0 errores / 4 advertencias / OK |
| Frontend en navegador | ver §4 |

**Qué no es «real»:** en el flujo HTTP, las propuestas y el cierre de casos los simulé yo (n8n no existe aquí); los cierres de caso se hicieron por SQL en la base desechable solo para no agotar el límite de 3.

## 9. Estado de Git y condiciones

Un `git merge-tree` no destructivo de `diego` sobre `develop` indica merge limpio (ver informe del chat). No se hizo merge, rebase ni push a `develop`/`main`.

**Condiciones para fusionar a `develop`:** aprobar este informe; decisión sobre el frontend del compañero (§5); definir si el merge arrastra el frontend completo (lo hace: `develop` hoy no tiene frontend); PostgreSQL 17/18 o suite `conc:*` si se exige.
**Condiciones para aplicar migraciones en Neon:** copia/rama de recuperación; confirmar versión de PostgreSQL; verificar el estado aplicado; ejecutar `0003` y `0004` en orden; comprobaciones de §10.
**Condiciones para desplegar en Render:** migraciones aplicadas; `infra/render/render.yaml` versionado tiene `autoDeployTrigger: "off"` y `branch: develop` (el estado operativo en el panel **debe comprobarse**: si hubiera auto-deploy, un merge a `develop` desplegaría solo); `FRONTEND_URL` con `https` (+ `http://localhost:5173` si se quiere); `N8N_SERVICE_TOKEN` configurado.

## 10. Qué debe hacer la responsable del proyecto después de recibir esta entrega

1. **Revisar:** este informe; el diff `develop…diego` del backend (57 archivos) y de las migraciones; los defectos de frontend corregidos (§2, 6–8); la sección de riesgos residuales (§11).
2. **Migraciones (cuando decidas):** crear una rama/copia de recuperación en Neon; verificar versión de PostgreSQL y estado actual de `drizzle.__drizzle_migrations`; aplicar `0003` y `0004` con `npm run db:migrate` desde `backend/` con `DATABASE_URL_DIRECT` (conexión directa, sin pooler). Verificar con consultas **de solo lectura**: `auto_generate` existe con default `false` y todas las filas valen `false`; el enum `proposal_application_action` tiene 6 valores; `proposal_applications.obligation_id`, `occurrence_id` y `rental_id` son nullable; existen `proposal_applications_exactly_one_resource` y `proposal_applications_rental_owner_fk`; las filas de `proposal_applications` cumplen el CHECK; `__drizzle_migrations` tiene 5 filas.
3. **Riesgos:** §11.
4. **Autorizar el merge** cuando: el compañero frontend haya confirmado cómo integra su trabajo (o decidas fusionar ya el frontend de Diego), hayas revisado el informe y quieras que `develop` incluya el frontend.
5. **Desplegar sin incompatibilidad:** migrar Neon → comprobar → desplegar el backend nuevo manualmente → adaptar n8n → desplegar el frontend (Vercel) y fijar `FRONTEND_URL` con el dominio definitivo.
6. **n8n:** [`ADAPTACIONES_N8N_PENDIENTES.md`](./ADAPTACIONES_N8N_PENDIENTES.md): A-1, A-2, A-3 (texto y voz), A-4, A-5, A-6; A-7 no existe.
7. **Pruebas reales:** texto y voz de extremo a extremo con n8n, recurrencia tras migrar, HITL con las 4 acciones, kill switch (`text_processing`, `recurrence_generation`), CORS con el dominio real de Vercel, micrófono en móvil real, Gmail.

## 11. Riesgos residuales

1. PostgreSQL probado en 15, no en 17/18; suite `conc:*` sin ejecutar.
2. Frontend sin pruebas automatizadas; cobertura manual parcial (§4).
3. D12 inferido (coincidencia fortuita de fechas).
4. Voz de extremo a extremo depende de adaptar el workflow 04 (A-3); hoy el backend la admite pero n8n no la llama.
5. Sin N8 (`upcoming`), la vista «Próximos períodos» solo puede mostrar los ya generados.
6. Chunk de 582 kB en el frontend (sin code-splitting).
7. `.claude/launch.json` (configuración del IDE) quedó versionado por Diego; inocuo, puede eliminarse.
