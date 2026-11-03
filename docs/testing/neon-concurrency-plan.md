# Plan de pruebas reales de concurrencia en PostgreSQL (Fase 4.2F.2)

Preparado en la Fase 4.2F.1. **No se ejecutó nada contra Neon.** Las herramientas existen y su lógica está validada sobre PGlite; la ejecución real es el objetivo de la Fase 4.2F.2.

## 1. Por qué hace falta

Todas las pruebas automatizadas usan PGlite: PostgreSQL real, pero con **una sola conexión**, donde las transacciones se serializan. Demuestran la lógica (`SKIP LOCKED`, actualizaciones condicionadas, restricciones únicas, idempotencia), pero **no** la contención entre conexiones independientes, que es lo que ocurre con el pool de la API, varios workers de n8n y varias instancias.

## 2. Restricciones del entorno

- Neon tiene **una sola rama, `production`**, con los datos demo y la auditoría append-only.
- **Ninguna prueba de negocio puede limpiarse.** Toda escritura deja:
  - eventos en `audit_events`, que no admite `UPDATE` ni `DELETE`, ni siquiera con la API, y no debe alterarse;
  - historial de propuestas y revisiones;
  - archivos.

  No existe un procedimiento válido para "deshacer" una prueba de negocio, y **no se debe diseñar uno** que borre historial protegido.
- Dos transacciones en conexiones distintas **no se pueden revertir conjuntamente**. Si una confirma, sus efectos quedan.
- Las cuentas, obligaciones, cobros y contratos demo **no se usan** en ninguna prueba de escritura.

## 3. Clasificación de las pruebas

| Clase | Efecto persistente | Dónde |
|---|---|---|
| **A. Bloqueos sin modificaciones** | Ninguno lógico: ambas transacciones terminan en `ROLLBACK`; un bloqueo de fila solo marca la tupla (xmax) | Puede ejecutarse en `production`, con aprobación |
| **B. Datos aislados en PostgreSQL** | Registros sintéticos y auditoría | **No** en `production` |
| **C. Pruebas de negocio por la API** | Casos, propuestas, revisiones, períodos y auditoría | Solo en un **entorno descartable** |
| **D. Entorno descartable** | Se elimina completo al terminar | Rama temporal de Neon o PostgreSQL local con varias conexiones |

**Recomendación (REQUIERE DECISIÓN):** ejecutar la clase A en `production` y las clases B y C en una **rama temporal de Neon** creada a partir de `production`.

- La rama copia el esquema y los datos sin afectar el original.
- Se borra entera al terminar, lo cual sí es válido porque es un entorno descartable.
- Prueba el mismo motor y la misma red.

Crear la rama es una decisión explícita: esta fase no la creó. Alternativa sin Neon: un PostgreSQL 16 o superior local (Docker) con las migraciones aplicadas. Valida la contención real, pero no la latencia ni el pooler de Neon.

## 4. Herramientas preparadas

| Herramienta | Clase | Salvaguardas |
|---|---|---|
| `src/database/scripts/concurrency/lock-probe.ts` | A | Exige `LOCK_PROBE_CONFIRM=lock-only-rollback`. Dos `pg.Client` con PIDs distintos (se verifica). Solo `SELECT … FOR UPDATE [SKIP LOCKED / NOWAIT]` y `ROLLBACK`, sin INSERT, UPDATE, DELETE ni DDL. `lock_timeout` de 5 s. |
| `src/database/scripts/concurrency/run-concurrency-suite.ts` + `scenarios.ts` | C | Exige `CONCURRENCY_ACK=writes-persist-on-disposable-branch` y `CONCURRENCY_DB_HOST` igual al host de `DATABASE_URL_DIRECT` (confirmación explícita del destino). Se niega a correr en Render, CI o `NODE_ENV=production`. Las credenciales se leen de un archivo fuera del repositorio. Las verificaciones usan `BEGIN READ ONLY`. Se detiene en el primer fallo. |
| `test/concurrency-scenarios.e2e-spec.ts` | — | Ejecuta los mismos escenarios en proceso sobre PGlite: valida la **lógica**, no la contención. |

Compilación: `npm run build`. Ejecución:

```bash
node --env-file=.env dist/database/scripts/concurrency/lock-probe.js
node --env-file=.env dist/database/scripts/concurrency/run-concurrency-suite.js
```

Las variables de confirmación van en la línea de comandos; los secretos, en `backend/.env`.

## 5. Escenarios

Cada escenario de la clase C crea **sus propios datos sintéticos** por la API, marcados con `CONC <runId>`: obligaciones, períodos con fechas de 2099, inmuebles, arriendos y casos. No toca registros existentes.

| # | Escenario | Procedimiento | Resultado esperado | Verificación |
|---|---|---|---|---|
| 1 | Dos conexiones independientes | `lock-probe` (clase A) | PIDs distintos; `SKIP LOCKED` omite la fila bloqueada; `NOWAIT` → 55P03; tras el `ROLLBACK` la fila queda libre | Salida ✓ y checksum de datos igual antes y después |
| 2 | Reclamación simultánea del mismo trabajo | `claim-race`: 3 `claim` simultáneos | El trabajo aparece en **una** sola respuesta | Por la API |
| 3 | Reclamación vencida y nueva | `stale-worker`: claim con 30 s de arrendamiento, espera de 32 s, nuevo claim | El nuevo titular completa (200); el antiguo recibe 409 | 1 evento `workflow_job.complete` |
| 4 | Respuesta del worker antiguo | Incluido en el 3 (`complete` simultáneos de ambos tokens) | Solo cuenta el vigente | Auditoría de solo lectura |
| 5 | Confirmaciones concurrentes de una obligación | `occurrence-confirm-race`: 4 × `paid` + 1 × `attended` | Una confirmación; las iguales son idempotentes (200) y la contradictoria recibe 409 | 1 evento `obligation_occurrence.confirm` |
| 6 | Confirmaciones concurrentes de un cobro | `rent-charge-confirm-race`: 5 × confirm | 200 idempotente | 1 evento `rent_charge.confirm` |
| 7 | Decisiones HITL contradictorias | `contradictory-hitl`: aprobar y rechazar a la vez | Estados `200, 409` | 1 evento de decisión |
| 8 | Aplicaciones simultáneas de una propuesta | `apply-race`: 5 × apply | Estados `201, 200 × 4` | 1 fila en `proposal_applications` |
| 9 | Casos con la misma clave de idempotencia | `duplicate-case-request`: 6 × POST con el mismo `requestId` | `201, 200 × 5`, mismo id | Por la API |
| 10 | Evaluaciones de alertas simultáneas | `alert-evaluation-race`: 3 × evaluate | 200 en todas | Como máximo 1 alerta activa por período |

La contención es real porque la API usa un `pg.Pool` de hasta 5 conexiones: las solicitudes simultáneas se ejecutan en conexiones distintas. Para forzar más paralelismo, ejecutar **dos instancias** de la API contra la misma base en puertos distintos y repartir las solicitudes (variante recomendada para los escenarios 2, 7 y 8).

Advertencia del escenario 2: `claim` toma **cualquier** trabajo disponible del tipo indicado, no solo los del escenario. Por eso la clase C exige un entorno sin workers ni trabajos reales.

## 6. Procedimiento

1. **Decisión previa:** aprobar la rama temporal (o PostgreSQL local) y la ventana de ejecución.
2. **Clase A en `production` (opcional, con aprobación):**
   1. Ejecutar `npm run db:check`.
   2. Tomar el checksum de solo lectura de la sección 7.
   3. Ejecutar `lock-probe`.
   4. Repetir el checksum: debe ser idéntico.
3. **Rama temporal:**
   1. Crearla desde `production` en la consola de Neon (*Branches → Create branch*), sin cómputo compartido.
   2. Obtener sus cadenas de conexión: host propio `ep-…`.
   3. Escribirlas en un `.env` **separado** fuera de OneDrive, sin reutilizar `backend/.env`.
4. **API contra la rama:**
   1. `NODE_ENV=development` y `DATABASE_URL` de la rama.
   2. `N8N_SERVICE_TOKEN` de prueba distinto del real.
   3. Almacenamiento local.
   4. Opcional: dos instancias en puertos distintos.
5. **Credenciales de prueba:** en la rama, rotar la contraseña de **una** cuenta demo con `rotate-demo-passwords` (afecta solo a la rama), o usar las actuales. Guardar `email<TAB>contraseña` en un archivo fuera del repositorio.
6. **Ejecutar la suite** con `CONCURRENCY_ACK`, `CONCURRENCY_DB_HOST` (host de la rama), `CONCURRENCY_API_URL` y `CONCURRENCY_CREDENTIALS_FILE`. Para repetir solo algunos escenarios: `CONCURRENCY_SCENARIOS=claim-race,apply-race`.
7. Repetir cada escenario al menos 5 veces. Los fallos de concurrencia son probabilísticos.
8. **Cierre:** guardar la salida y eliminar la rama completa. Es la única limpieza válida.

## 7. Verificación de efectos persistentes

**Antes y después de la clase A en `production`** (solo lectura):

```sql
BEGIN READ ONLY;
SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
  SELECT 'o'||id||status||due_date||coalesce(amount::text,'') AS x FROM obligation_occurrences
  UNION ALL SELECT 'r'||id||status||due_date||expected_amount FROM rent_charges
  UNION ALL SELECT 'c'||id||status||ends_on FROM contracts
  UNION ALL SELECT 'a'||id||password_changed_at||is_active FROM auth_accounts) s;
SELECT count(*) FROM audit_events;
ROLLBACK;
```

**En la rama, tras la clase C:**

- conteos de auditoría por acción y recurso, que la suite ya verifica;
- `SELECT count(*) FROM alerts WHERE state = 'active' GROUP BY occurrence_id HAVING count(*) > 1`, que debe devolver 0 filas;
- ningún trabajo `claimed` con `locked_by` de dos workers.

## 8. Criterios para detener la ejecución

- Cualquier escenario con resultado distinto del esperado: la suite se detiene sola. Se registra la salida y **no** se reintenta hasta analizarlo.
- `lock-probe` informa PIDs iguales, o el checksum de `production` cambia.
- Errores 5xx repetidos, `deadlock_detected` (40P01) o tiempos de bloqueo superiores al `lock_timeout`.
- Cualquier indicio de que el destino no es el previsto: host distinto, datos inesperados.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Ejecutar la clase C en `production` por error | Doble confirmación (`CONCURRENCY_ACK` + host exacto); `.env` separado para la rama |
| `claim` toma trabajos ajenos | Entorno descartable sin workers |
| Costos o límites de Neon (cómputo de la rama) | Rama de vida corta; se elimina al terminar |
| Resultados no concluyentes por baja concurrencia | Dos instancias de la API y repeticiones |
| Espera real de 32 s en `stale-worker` | Esperada (arrendamiento mínimo de 30 s) |
