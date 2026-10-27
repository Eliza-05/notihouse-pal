import { ConflictException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AuditService } from '../audit/audit.service.js';
import {
  type ProcessActor,
  recordProcessEvent,
} from '../audit/process-actor.js';
import type { DbTransaction } from '../database/database.constants.js';
import {
  cases,
  caseStatus,
  hitlRequests,
  workflowJobs,
} from '../database/schema/index.js';

export const CASE_STATUSES = caseStatus.enumValues;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const TERMINAL_CASE_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly CaseStatus[];

/**
 * Transiciones válidas de un caso. Ninguna se expone como PATCH genérico:
 * cada una la provoca una acción concreta (ver docs/api/workflow-integration.md).
 * `cancelled` existe en el esquema pero no tiene transición en esta fase.
 */
export const CASE_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  received: ['processing', 'awaiting_human', 'completed', 'failed'],
  processing: ['awaiting_human', 'completed', 'failed'],
  awaiting_human: ['processing', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const caseColumns = {
  id: cases.id,
  ownerId: cases.ownerId,
  correlationId: cases.correlationId,
  type: cases.type,
  source: cases.source,
  status: cases.status,
  obligationId: cases.obligationId,
  rentalId: cases.rentalId,
  contractId: cases.contractId,
  statusReason: cases.statusReason,
  closedAt: cases.closedAt,
  createdAt: cases.createdAt,
  updatedAt: cases.updatedAt,
};

export type CaseRow = Pick<typeof cases.$inferSelect, keyof typeof caseColumns>;

export const isTerminalCase = (status: CaseStatus) =>
  (TERMINAL_CASE_STATUSES as readonly string[]).includes(status);

const COMPONENT = 'process.cases';

/**
 * Bloquea el caso (`FOR UPDATE`). Orden de bloqueo en todo el backend:
 * trabajo → caso → propuestas / solicitudes HITL, para evitar interbloqueos.
 */
export async function lockCase(
  tx: DbTransaction,
  caseId: string,
): Promise<CaseRow | null> {
  const [row] = await tx
    .select(caseColumns)
    .from(cases)
    .where(eq(cases.id, caseId))
    .for('update');
  return row ?? null;
}

/**
 * Aplica una transición autorizada sobre un caso ya bloqueado y la audita.
 * Repetir el estado actual no hace nada. Al cerrar el caso se anulan sus
 * revisiones HITL pendientes y sus trabajos aún no reclamados.
 */
export async function transitionCase(
  tx: DbTransaction,
  audit: AuditService,
  current: CaseRow,
  to: CaseStatus,
  actor: ProcessActor,
  reason?: string,
): Promise<CaseRow> {
  if (current.status === to) return current;
  if (!CASE_TRANSITIONS[current.status].includes(to)) {
    throw new ConflictException(
      `El caso no puede pasar de "${current.status}" a "${to}"`,
    );
  }
  const terminal = isTerminalCase(to);
  const [row] = await tx
    .update(cases)
    .set({
      status: to,
      ...(reason !== undefined ? { statusReason: reason } : {}),
      ...(terminal ? { closedAt: sql`now()` } : {}),
    })
    .where(and(eq(cases.id, current.id), eq(cases.status, current.status)))
    .returning(caseColumns);
  if (!row) {
    throw new ConflictException('El caso cambió de estado; reintenta');
  }
  const event = {
    ownerId: row.ownerId,
    correlationId: row.correlationId,
    component: COMPONENT,
  };
  await recordProcessEvent(audit, tx, actor, {
    ...event,
    action: 'case.status_change',
    resource: 'case',
    resourceId: row.id,
    details: {
      statusFrom: current.status,
      statusTo: to,
      ...(reason ? { reason } : {}),
    },
  });

  if (terminal) {
    const cancelledHitl = await tx
      .update(hitlRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(hitlRequests.caseId, row.id),
          eq(hitlRequests.status, 'pending'),
        ),
      )
      .returning({ id: hitlRequests.id });
    // SKIP LOCKED: un trabajo bloqueado por otro worker no detiene el cierre;
    // la reclamación excluye de todos modos los trabajos de casos cerrados.
    const cancelledJobs = await tx
      .update(workflowJobs)
      .set({ status: 'cancelled', lockedUntil: null })
      .where(
        inArray(
          workflowJobs.id,
          tx
            .select({ id: workflowJobs.id })
            .from(workflowJobs)
            .where(
              and(
                eq(workflowJobs.caseId, row.id),
                eq(workflowJobs.status, 'pending'),
              ),
            )
            .for('update', { skipLocked: true }),
        ),
      )
      .returning({ id: workflowJobs.id });
    for (const { id } of cancelledHitl) {
      await recordProcessEvent(
        audit,
        tx,
        { kind: 'system' },
        {
          ...event,
          action: 'hitl_request.cancel',
          resource: 'hitl_request',
          resourceId: id,
          details: { caseId: row.id, reason: 'case_closed' },
        },
      );
    }
    for (const { id } of cancelledJobs) {
      await recordProcessEvent(
        audit,
        tx,
        { kind: 'system' },
        {
          ...event,
          action: 'workflow_job.cancel',
          resource: 'workflow_job',
          resourceId: id,
          details: { caseId: row.id, reason: 'case_closed' },
        },
      );
    }
  }
  return row;
}

/** ¿Quedan solicitudes HITL pendientes en el caso? (con el caso ya bloqueado) */
export async function hasPendingHitl(
  tx: DbTransaction,
  caseId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: hitlRequests.id })
    .from(hitlRequests)
    .where(
      and(eq(hitlRequests.caseId, caseId), eq(hitlRequests.status, 'pending')),
    )
    .limit(1);
  return row !== undefined;
}
