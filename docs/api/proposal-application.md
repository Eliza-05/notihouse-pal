# Aplicación controlada de propuestas aprobadas (Fase 4.2E)

> **La IA propone, las reglas determinísticas validan y el backend ejecuta solamente las operaciones expresamente autorizadas.**

Aprobar una propuesta en una revisión humana (HITL) **no** autoriza ejecutar cualquier cosa que aparezca en su JSON. El backend interpreta exclusivamente acciones de una lista cerrada, con DTO tipados, y las ejecuta con los mismos servicios de negocio que usa la API.

## 1. Endpoint

`POST /api/v1/cases/:caseId/proposals/:proposalId/apply` — JWT de usuario. **Cuerpo vacío**: cualquier campo (`amount`, `ownerId`…) responde 400. Los datos aplicados son únicamente los de la propuesta aprobada; si hay que corregirlos, debe registrarse una nueva propuesta y aprobarse.

| Respuesta | Cuándo |
|---|---|
| 201 | Aplicada ahora |
| 200 | Ya estaba aplicada (`alreadyApplied: true`, misma respuesta) |
| 400 | Acción no permitida, formato inválido, datos inválidos, moneda distinta, obligación distinta de la del caso |
| 404 | Caso, propuesta u obligación inexistentes o ajenos |
| 409 | Propuesta no aprobada, rechazada, reemplazada o no es la última versión; revisión inválida o fuera de plazo; caso `failed`/`cancelled`; tipo de caso no aplicable; período duplicado; obligación duplicada |

```json
{
  "caseId": "…", "proposalId": "…", "proposalVersion": 1, "hitlRequestId": "…",
  "action": "create_obligation_occurrence",
  "status": "applied", "alreadyApplied": false, "appliedAt": "2026-11-18T15:00:00.000Z",
  "resource": { "type": "obligation_occurrence", "id": "…", "obligationId": "…", "status": "pending" },
  "createdObligationId": null,
  "correlationId": "…"
}
```

`resource.status` es el estado **actual** del período (se crea `pending`). Aplicar nunca significa que la factura quedó pagada. La cabecera `X-Correlation-Id` devuelve el `correlation_id` del caso.

## 2. Formato aplicable de `proposed_data`

```json
{ "action": "<acción permitida>", "data": { … } }
```

Cualquier otra clave en el nivel superior, o un JSON libre (p. ej. `{ "amount": "…", "dueDate": "…" }`), no es aplicable (400) y debe completarse manualmente desde el frontend.

### 2.1 Acciones permitidas

**`create_obligation_occurrence`** — período `pending` de una obligación existente.

```json
{
  "action": "create_obligation_occurrence",
  "data": {
    "obligationId": "uuid",
    "periodStart": "2026-11-01", "periodEnd": "2026-11-30", "dueDate": "2026-11-18",
    "amount": "145000.00",
    "currency": "COP"
  }
}
```

- Mismas validaciones que `POST /obligations/:id/occurrences` (`CreateOccurrenceDto`): fechas reales `YYYY-MM-DD`, `periodEnd ≥ periodStart`, monto decimal como texto con máx. 2 decimales y no negativo.
- `amount` opcional: si falta, se copia el valor esperado de la obligación. `currency` opcional: si viene, debe coincidir con la de la obligación (no se convierten monedas).
- La obligación debe ser del usuario y no estar archivada. Si el caso se refiere a una obligación, debe ser la misma.
- No puede existir ya un período con el mismo `periodStart` (409; el existente no se modifica).

**`create_obligation_with_occurrence`** — definición nueva (siempre `active`) y su primer período.

```json
{
  "action": "create_obligation_with_occurrence",
  "data": {
    "obligation": { "providerName": "Gas Natural", "concept": "Gas", "category": "gas", "expectedAmount": "48000.00" },
    "occurrence": { "periodStart": "2026-11-01", "periodEnd": "2026-11-30", "dueDate": "2026-11-20" }
  }
}
```

- `obligation` usa las validaciones de `POST /obligations` sin `status`; `occurrence`, las de `CreateOccurrenceDto`. Los campos obligatorios (`providerName`, `concept`, `category`, fechas) no se inventan: si faltan, 400.
- Se rechaza (409) si el caso ya se refiere a una obligación o si existe una obligación no archivada del usuario con el mismo proveedor y concepto (sin distinguir mayúsculas): en ese caso corresponde aplicar un período sobre ella.

### 2.2 Acciones prohibidas

No existe código que las ejecute; cualquier otro nombre de acción responde 400:

- Marcar una obligación como pagada o atendida, o modificar `confirmed_by`/`confirmed_at`.
- Marcar un cobro como recibido.
- Renovar, terminar o cambiar fechas de un contrato.
- Cambiar propietarios, borrar historial o crear recursos de otro usuario.
- Saltarse la revisión humana o ejecutar operaciones desconocidas.

Los DTO rechazan campos no declarados también dentro de `data` (p. ej. `status: "paid"`, `confirmedBy`, `ownerId`, `table`). Nunca se usan nombres de tabla, columnas ni SQL provenientes del JSON. Las confirmaciones de pago e ingreso siguen exclusivamente en `/occurrences/:id/confirm` y `/charges/:id/confirm`.

## 3. Validaciones, en orden

1. El caso existe y es del usuario (404).
2. La propuesta existe y pertenece a ese caso y propietario (404).
3. Si ya se aplicó, se devuelve la aplicación existente (200).
4. El caso no está `failed` ni `cancelled` (409).
5. La propuesta está `accepted` (409 si `pending_review`, `rejected` o `superseded`).
6. Es la última versión del caso (409 si existe una más reciente).
7. Existe una revisión HITL del mismo caso, vinculada a esta propuesta, asignada al usuario, en estado `approved`, con decisión `approved`, **respondida antes de su `due_at`**, de tipo `data_confirmation` y **sin alternativas** (409 en otro caso). Una revisión con alternativas no autoriza la aplicación automática porque la alternativa elegida no forma parte de la propuesta aprobada.
8. El caso es de tipo `household_obligation` (409).
9. `proposed_data` cumple el formato, la acción permitida y su DTO (400).
10. Reglas de negocio de la acción (recursos propios, moneda, duplicados).

## 4. Procedimiento, idempotencia y concurrencia

Todo ocurre en **una transacción** de PostgreSQL:

1. Bloqueo del caso (`SELECT … FOR UPDATE`), respetando el orden de bloqueo del backend (trabajo → caso → propuestas/revisiones).
2. Validaciones.
3. Creación de la obligación (si aplica) y del período mediante `ObligationsService.insertObligation` y `OccurrencesService.insertPending`, los mismos métodos que usan `POST /obligations` y `POST /obligations/:id/occurrences` (refactorización interna sin cambios en su API pública).
4. Inserción en `proposal_applications`.
5. Auditoría.

**Persistencia (`proposal_applications`, migración `0002`).** Registra que una propuesta se aplicó **exactamente una vez**: `proposal_id` es `UNIQUE`; además `occurrence_id` es único, `applied_by = owner_id` (check) y hay FKs compuestas con el propietario hacia `case_proposals`, `cases` y `obligations`, y FKs hacia `hitl_requests`, `obligation_occurrences` y `profiles`. No se usa `audit_events` como mecanismo de exclusión ni se modifica el historial de versiones de propuestas (`case_proposals` no cambia al aplicar).

| Caso | Resultado |
|---|---|
| Doble clic / reintento tras timeout | La segunda solicitud espera el bloqueo del caso, encuentra la aplicación y devuelve 200 `alreadyApplied: true` con el mismo recurso. Un solo período, una sola aplicación, un solo `case_proposal.apply`. |
| Solicitudes simultáneas | Solo una produce la mutación (201); el resto, 200. Si dos conexiones distintas compitieran sin bloqueo, la restricción única revierte la segunda, que devuelve la aplicación existente. |
| Propuesta reemplazada | 409. |
| Período ya existente | 409; el período existente no cambia. |
| Fallo de auditoría | Se revierte todo (período, obligación, aplicación). |
| Worker retrasado (`hitl.decision`) | La cola solo informa la decisión; completar ese trabajo no aplica nada y el token de servicio no puede llamar a la ruta de aplicación (401). La política de `complete` de la cola no cambió. |

## 5. Auditoría y trazabilidad

- Éxito: `case_proposal.apply` (recurso `case_proposal`) con `caseId`, `proposalId`, `proposalVersion`, `hitlRequestId`, `applicationId`, `action`, `obligationId`, `occurrenceId`, `createdObligation`, `occurrenceStatus: "pending"`, `humanApproval: true`, `appliedToBusinessData: true`. Los eventos `obligation.create` y `obligation_occurrence.create` llevan `source: "case_proposal"` y las mismas referencias. Sin montos ni contenido de la propuesta.
- Todos usan el `correlation_id` del caso, por lo que se puede reconstruir: documento o voz → caso → propuesta → HITL → aprobación → aplicación.
- Rechazo (400/404/409 una vez verificado que el caso es del usuario): `case_proposal.apply` con `result: failure`, `httpStatus` y motivo, en una transacción aparte (la de negocio ya se revirtió). Si esa auditoría falla, se informa el error original. Un intento sobre un caso ajeno no se registra en la cuenta de su dueño.

## 6. Limitaciones

- Solo hay acciones para obligaciones del hogar. Arriendos y contratos no tienen acciones aplicables (por diseño, nunca se confirman ingresos ni se renuevan contratos desde una propuesta).
- La concurrencia se probó con PGlite (una conexión, transacciones serializadas). La contención entre conexiones reales de Neon queda pendiente.
- La deduplicación de propuestas anteriores y las respuestas contradictorias de `complete` siguen pendientes de probarse con workflows reales.
