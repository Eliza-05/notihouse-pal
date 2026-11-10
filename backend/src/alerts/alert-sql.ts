import { inArray, sql } from 'drizzle-orm';
import {
  alerts,
  contracts,
  hitlRequests,
  obligationOccurrences as occurrences,
  rentCharges,
} from '../database/schema/index.js';
import { OPEN_STATUSES } from '../due-dates/due-date.rules.js';

/**
 * ¿La alerta sigue vigente? Activa y con su recurso todavía abierto en la
 * misma fecha. Se calcula al consultar, sin escribir: una alerta cuyo período
 * ya se confirmó (o cuya fecha cambió) deja de mostrarse como pendiente de
 * inmediato, aunque la evaluación interna aún no la haya marcado resuelta.
 */
export const effectivelyActive = sql<boolean>`(${alerts.state} = 'active' AND (
  EXISTS (SELECT 1 FROM ${occurrences} WHERE ${occurrences.id} = ${alerts.occurrenceId}
    AND ${occurrences.ownerId} = ${alerts.ownerId}
    AND ${inArray(occurrences.status, [...OPEN_STATUSES.obligation_occurrence])}
    AND ${occurrences.dueDate} = ${alerts.relevantDate})
  OR EXISTS (SELECT 1 FROM ${rentCharges} WHERE ${rentCharges.id} = ${alerts.rentChargeId}
    AND ${rentCharges.ownerId} = ${alerts.ownerId}
    AND ${inArray(rentCharges.status, [...OPEN_STATUSES.rent_charge])}
    AND ${rentCharges.dueDate} = ${alerts.relevantDate})
  OR EXISTS (SELECT 1 FROM ${contracts} WHERE ${contracts.id} = ${alerts.contractId}
    AND ${contracts.ownerId} = ${alerts.ownerId}
    AND ${inArray(contracts.status, [...OPEN_STATUSES.contract])}
    AND ${contracts.endsOn} = ${alerts.relevantDate})
  OR EXISTS (SELECT 1 FROM ${hitlRequests} WHERE ${hitlRequests.id} = ${alerts.hitlRequestId}
    AND ${hitlRequests.ownerId} = ${alerts.ownerId}
    AND ${inArray(hitlRequests.status, [...OPEN_STATUSES.hitl_request])})
))`;

/** Estado presentado: una alerta activa cuyo recurso ya se cerró se muestra resuelta. */
export const effectiveState = sql<
  'active' | 'dismissed' | 'resolved'
>`(CASE WHEN ${alerts.state} = 'active' AND NOT ${effectivelyActive} THEN 'resolved' ELSE ${alerts.state}::text END)`;
