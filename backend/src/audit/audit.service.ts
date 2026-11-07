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
  /** `failure` registra un intento fallido (por ejemplo, de almacenamiento). */
  result?: 'success' | 'failure';
}

/** Acción no humana: el servicio de automatización o una regla del sistema. */
export interface AutomatedAuditEvent {
  /** Propietario del caso afectado (determinado por PostgreSQL, nunca por el cliente). */
  ownerId: string;
  correlationId: string;
  actorType: 'workflow' | 'system';
  /** Identificador del componente, p. ej. `n8n:worker-1` o `api`. */
  actorId: string;
  component: string;
  action: string;
  resource: string;
  resourceId: string;
  details?: Record<string, unknown>;
  /** `failure` registra un intento fallido (por ejemplo, de almacenamiento). */
  result?: 'success' | 'failure';
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
      result: event.result ?? 'success',
      metadata: {
        resource: event.resource,
        resourceId: event.resourceId,
        ...event.details,
      },
    });
  }

  async recordAutomatedAction(
    tx: DbTransaction,
    event: AutomatedAuditEvent,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      correlationId: event.correlationId,
      ownerId: event.ownerId,
      actorType: event.actorType,
      actorId: event.actorId,
      component: event.component,
      action: event.action,
      result: event.result ?? 'success',
      metadata: {
        resource: event.resource,
        resourceId: event.resourceId,
        ...event.details,
      },
    });
  }
}
