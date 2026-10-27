import { Injectable } from '@nestjs/common';
import type { DbTransaction } from '../database/database.constants.js';
import { auditEvents } from '../database/schema/index.js';

export interface UserAuditEvent {
  /** Perfil autenticado que ejecuta la acción (propietario y actor). */
  profileId: string;
  correlationId: string;
  component: string;
  action: string;
  resource: string;
  resourceId: string;
  /** Metadatos mínimos: nombres de campos y transiciones, nunca secretos. */
  details?: Record<string, unknown>;
}

/**
 * Registra eventos en `audit_events` (append-only) dentro de la transacción
 * de la operación de negocio: si la auditoría falla, la operación se revierte.
 */
@Injectable()
export class AuditService {
  async recordUserAction(
    tx: DbTransaction,
    event: UserAuditEvent,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      correlationId: event.correlationId,
      ownerId: event.profileId,
      actorType: 'user',
      actorId: event.profileId,
      component: event.component,
      action: event.action,
      result: 'success',
      metadata: {
        resource: event.resource,
        resourceId: event.resourceId,
        ...event.details,
      },
    });
  }
}
