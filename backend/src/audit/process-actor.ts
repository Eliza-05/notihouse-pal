import type { DbTransaction } from '../database/database.constants.js';
import type { AuditService } from './audit.service.js';

/**
 * Quién provoca una transición de proceso: un usuario autenticado, el
 * servicio de automatización (un worker de n8n) o una regla del propio backend.
 */
export type ProcessActor =
  | { kind: 'user'; profileId: string }
  | { kind: 'workflow'; workerId: string }
  | { kind: 'system' };

export interface ProcessEvent {
  ownerId: string;
  correlationId: string;
  component: string;
  action: string;
  resource: string;
  resourceId: string;
  details?: Record<string, unknown>;
}

/** Registra el evento con el tipo de actor correcto, dentro de `tx`. */
export function recordProcessEvent(
  audit: AuditService,
  tx: DbTransaction,
  actor: ProcessActor,
  event: ProcessEvent,
): Promise<void> {
  if (actor.kind === 'user') {
    if (actor.profileId !== event.ownerId) {
      // Un usuario solo actúa sobre sus propios procesos; nunca debería ocurrir.
      throw new Error('El actor no es el propietario del proceso');
    }
    return audit.recordUserAction(tx, {
      profileId: actor.profileId,
      ...event,
    });
  }
  return audit.recordAutomatedAction(tx, {
    ...event,
    actorType: actor.kind,
    actorId: actor.kind === 'workflow' ? `n8n:${actor.workerId}` : 'api',
  });
}
