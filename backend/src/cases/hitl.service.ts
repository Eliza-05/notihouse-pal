import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, lte, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import {
  type ProcessActor,
  recordProcessEvent,
} from '../audit/process-actor.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { offsetOf, type Page } from '../common/pagination.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import { caseProposals, hitlRequests } from '../database/schema/index.js';
import { WorkflowJobsService } from '../integrations/workflow-jobs.service.js';
import {
  type CaseRow,
  hasPendingHitl,
  isTerminalCase,
  lockCase,
  transitionCase,
} from './case-lifecycle.js';
import { proposalColumns } from './cases.service.js';
import type {
  DecideHitlDto,
  HitlDetailDto,
  HitlOutcome,
  HitlResponseDto,
  ListHitlQueryDto,
} from './dto/process.dto.js';

const COMPONENT = 'api.hitl-requests';
export const HITL_NOT_FOUND = 'Solicitud de revisión no encontrada';
export const HITL_EXPIRED =
  'La solicitud venció sin decisión: ya no puede aprobarse ni rechazarse';

export const hitlColumns = {
  id: hitlRequests.id,
  caseId: hitlRequests.caseId,
  proposalId: hitlRequests.proposalId,
  decisionType: hitlRequests.decisionType,
  status: hitlRequests.status,
  /** Pendiente con la fecha límite cumplida según el reloj de PostgreSQL. */
  overdue: sql<boolean>`(${hitlRequests.status} = 'pending' AND ${hitlRequests.dueAt} <= now())`,
  options: hitlRequests.options,
  decision: hitlRequests.decision,
  createdAt: hitlRequests.createdAt,
  dueAt: hitlRequests.dueAt,
  respondedAt: hitlRequests.respondedAt,
  updatedAt: hitlRequests.updatedAt,
};

interface StoredDecision {
  outcome: HitlOutcome;
  choice?: string;
  comment?: string;
}

interface StoredOptions {
  summary?: string;
  choices?: { key: string; label: string }[];
}

/**
 * Revisiones humanas. Solo el usuario asignado (siempre el propietario del
 * caso) decide. Aprobar registra la decisión y acepta la propuesta vinculada,
 * pero NO aplica ningún dato a tablas financieras: esa ejecución exige una
 * operación de negocio específica (fase posterior).
 */
@Injectable()
export class HitlService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly jobs: WorkflowJobsService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListHitlQueryDto,
  ): Promise<Page<HitlResponseDto>> {
    const filters: SQL[] = [this.ownedBy(user)];
    if (query.status) filters.push(eq(hitlRequests.status, query.status));
    if (query.caseId) filters.push(eq(hitlRequests.caseId, query.caseId));
    const where = and(...filters);
    const [items, [total]] = await Promise.all([
      this.db
        .select(hitlColumns)
        .from(hitlRequests)
        .where(where)
        .orderBy(desc(hitlRequests.createdAt), desc(hitlRequests.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(hitlRequests).where(where),
    ]);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: total!.n,
    };
  }

  async findOne(user: AuthenticatedUser, id: string): Promise<HitlDetailDto> {
    const [row] = await this.db
      .select(hitlColumns)
      .from(hitlRequests)
      .where(and(eq(hitlRequests.id, id), this.ownedBy(user)));
    if (!row) throw new NotFoundException(HITL_NOT_FOUND);
    return this.withProposal(this.db, row);
  }

  /**
   * Decisión explícita del usuario.
   * - Solo sobre solicitudes `pending` con la fecha límite vigente (se
   *   comprueba con `now()` aunque nadie haya materializado el vencimiento).
   * - Una solicitud vencida se marca `expired` (y se registra) y responde 409:
   *   el vencimiento nunca equivale a aprobación.
   * - Repetir la misma decisión devuelve la solicitud sin cambios; una
   *   decisión distinta responde 409.
   * Orden de bloqueo: caso → solicitud → propuesta.
   */
  async decide(
    user: AuthenticatedUser,
    id: string,
    dto: DecideHitlDto,
  ): Promise<HitlDetailDto> {
    const actor: ProcessActor = { kind: 'user', profileId: user.profileId };
    const outcome = await this.db.transaction(async (tx) => {
      const [ref] = await tx
        .select({ caseId: hitlRequests.caseId })
        .from(hitlRequests)
        .where(and(eq(hitlRequests.id, id), this.ownedBy(user)));
      if (!ref) throw new NotFoundException(HITL_NOT_FOUND);
      const caseRow = (await lockCase(tx, ref.caseId))!;
      // `now()` es la hora de INICIO de la transacción: una decisión retenida
      // en un bloqueo no puede ampararse en ella para superar la fecha límite.
      const [current] = await tx
        .select({
          ...hitlColumns,
          deadlinePassed: sql<boolean>`${hitlRequests.dueAt} <= clock_timestamp()`,
        })
        .from(hitlRequests)
        .where(eq(hitlRequests.id, id))
        .for('update');

      if (current!.status === 'pending' && current!.deadlinePassed) {
        await this.expireLocked(tx, caseRow, id, { kind: 'system' });
        return { expired: true } as const;
      }
      if (current!.status === 'approved' || current!.status === 'rejected') {
        const stored = current!.decision as StoredDecision;
        if (
          stored.outcome === dto.decision &&
          (stored.choice ?? null) === (dto.choice ?? null)
        ) {
          return { row: current! } as const;
        }
        throw new ConflictException(
          `La solicitud ya fue decidida como "${current!.status}"`,
        );
      }
      if (current!.status !== 'pending') {
        throw new ConflictException(
          current!.status === 'expired'
            ? HITL_EXPIRED
            : `La solicitud está en estado "${current!.status}"`,
        );
      }

      const decision = this.buildDecision(
        current!.options as StoredOptions,
        dto,
      );
      const [row] = await tx
        .update(hitlRequests)
        .set({
          status: dto.decision,
          decision,
          respondedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(hitlRequests.id, id),
            eq(hitlRequests.status, 'pending'),
            sql`${hitlRequests.dueAt} > clock_timestamp()`,
          ),
        )
        .returning(hitlColumns);
      if (!row) {
        throw new ConflictException(
          'La solicitud cambió de estado; consúltala de nuevo',
        );
      }
      const event = {
        ownerId: caseRow.ownerId,
        correlationId: caseRow.correlationId,
        component: COMPONENT,
      };
      await recordProcessEvent(this.audit, tx, actor, {
        ...event,
        action:
          dto.decision === 'approved'
            ? 'hitl_request.approve'
            : 'hitl_request.reject',
        resource: 'hitl_request',
        resourceId: id,
        details: {
          caseId: caseRow.id,
          decisionType: row.decisionType,
          humanDecision: true,
          ...(decision.choice ? { choice: decision.choice } : {}),
          hasComment: decision.comment !== undefined,
        },
      });

      if (row.proposalId) {
        await this.reviewProposal(
          tx,
          actor,
          event,
          row.proposalId,
          dto.decision,
        );
      }
      if (
        caseRow.status === 'awaiting_human' &&
        !(await hasPendingHitl(tx, caseRow.id))
      ) {
        await transitionCase(tx, this.audit, caseRow, 'processing', actor);
      }
      // n8n conoce la decisión por polling; el trabajo no ejecuta nada por sí mismo.
      await this.jobs.enqueue(tx, actor, {
        caseId: caseRow.id,
        ownerId: caseRow.ownerId,
        correlationId: caseRow.correlationId,
        jobType: 'hitl.decision',
        idempotencyKey: `hitl-decision:${id}`,
        payload: {
          hitlRequestId: id,
          decisionType: row.decisionType,
          decision: dto.decision,
          ...(decision.choice ? { choice: decision.choice } : {}),
          proposalId: row.proposalId,
        },
      });
      return { row } as const;
    });

    if ('expired' in outcome) throw new ConflictException(HITL_EXPIRED);
    return this.withProposal(this.db, outcome.row);
  }

  /**
   * Materializa vencimientos (operación interna para workflows programados).
   * Cada solicitud se procesa en su propia transacción con el orden de bloqueo
   * caso → solicitud; una solicitud decidida mientras tanto se omite.
   */
  async expireDue(actor: ProcessActor, limit: number): Promise<string[]> {
    const due = await this.db
      .select({ id: hitlRequests.id, caseId: hitlRequests.caseId })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.status, 'pending'),
          lte(hitlRequests.dueAt, sql`now()`),
        ),
      )
      .orderBy(asc(hitlRequests.dueAt), asc(hitlRequests.id))
      .limit(limit);
    const expired: string[] = [];
    for (const { id, caseId } of due) {
      const done = await this.db.transaction(async (tx) => {
        const caseRow = (await lockCase(tx, caseId))!;
        await tx
          .select({ id: hitlRequests.id })
          .from(hitlRequests)
          .where(eq(hitlRequests.id, id))
          .for('update');
        return this.expireLocked(tx, caseRow, id, actor);
      });
      if (done) expired.push(id);
    }
    return expired;
  }

  /**
   * Marca `expired` una solicitud pendiente cuya fecha límite pasó (caso y
   * solicitud ya bloqueados). Sin revisiones pendientes, el caso se detiene
   * como `failed`: un proceso sensible no continúa sin decisión humana.
   */
  private async expireLocked(
    tx: DbTransaction,
    caseRow: CaseRow,
    id: string,
    actor: ProcessActor,
  ): Promise<boolean> {
    const [row] = await tx
      .update(hitlRequests)
      .set({ status: 'expired' })
      .where(
        and(
          eq(hitlRequests.id, id),
          eq(hitlRequests.status, 'pending'),
          lte(hitlRequests.dueAt, sql`clock_timestamp()`),
        ),
      )
      .returning({
        decisionType: hitlRequests.decisionType,
        dueAt: hitlRequests.dueAt,
      });
    if (!row) return false;
    await recordProcessEvent(this.audit, tx, actor, {
      ownerId: caseRow.ownerId,
      correlationId: caseRow.correlationId,
      component: COMPONENT,
      action: 'hitl_request.expire',
      resource: 'hitl_request',
      resourceId: id,
      details: {
        caseId: caseRow.id,
        decisionType: row.decisionType,
        dueAt: row.dueAt.toISOString(),
        approved: false,
      },
    });
    if (
      !isTerminalCase(caseRow.status) &&
      !(await hasPendingHitl(tx, caseRow.id))
    ) {
      await transitionCase(
        tx,
        this.audit,
        caseRow,
        'failed',
        actor,
        'La revisión humana venció sin decisión',
      );
    }
    return true;
  }

  private buildDecision(
    options: StoredOptions,
    dto: DecideHitlDto,
  ): StoredDecision {
    const keys = (options.choices ?? []).map((c) => c.key);
    if (dto.choice !== undefined && !keys.includes(dto.choice)) {
      throw new BadRequestException(
        'choice no corresponde a ninguna alternativa',
      );
    }
    if (
      dto.decision === 'approved' &&
      keys.length > 0 &&
      dto.choice === undefined
    ) {
      throw new BadRequestException(
        'Para aprobar debes elegir una alternativa (choice)',
      );
    }
    if (dto.decision === 'rejected' && dto.choice !== undefined) {
      throw new BadRequestException('Un rechazo no lleva alternativa elegida');
    }
    return {
      outcome: dto.decision,
      ...(dto.choice !== undefined ? { choice: dto.choice } : {}),
      ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
    };
  }

  /**
   * Aprobar acepta la propuesta vinculada (debe seguir `pending_review`; si
   * fue reemplazada, 409 y nada se registra). Rechazar la marca rechazada.
   */
  private async reviewProposal(
    tx: DbTransaction,
    actor: ProcessActor & { kind: 'user' },
    event: { ownerId: string; correlationId: string; component: string },
    proposalId: string,
    outcome: HitlOutcome,
  ): Promise<void> {
    const [row] = await tx
      .update(caseProposals)
      .set({
        reviewStatus: outcome === 'approved' ? 'accepted' : 'rejected',
        reviewedAt: sql`now()`,
        reviewedBy: actor.profileId,
      })
      .where(
        and(
          eq(caseProposals.id, proposalId),
          eq(caseProposals.reviewStatus, 'pending_review'),
        ),
      )
      .returning({ id: caseProposals.id, version: caseProposals.version });
    if (!row) {
      if (outcome === 'approved') {
        throw new ConflictException(
          'La propuesta ya no está pendiente de revisión; no puede aprobarse',
        );
      }
      return;
    }
    await recordProcessEvent(this.audit, tx, actor, {
      ...event,
      action:
        outcome === 'approved'
          ? 'case_proposal.accept'
          : 'case_proposal.reject',
      resource: 'case_proposal',
      resourceId: row.id,
      details: { version: row.version, appliedToBusinessData: false },
    });
  }

  private async withProposal(
    executor: Database | DbTransaction,
    row: HitlResponseDto,
  ): Promise<HitlDetailDto> {
    if (!row.proposalId) return { ...row, proposal: null };
    const [proposal] = await executor
      .select(proposalColumns)
      .from(caseProposals)
      .where(eq(caseProposals.id, row.proposalId));
    return { ...row, proposal: proposal ?? null };
  }

  /** El propietario del caso y el usuario asignado deben ser quien consulta. */
  private ownedBy(user: AuthenticatedUser) {
    return and(
      eq(hitlRequests.ownerId, user.profileId),
      eq(hitlRequests.assignedTo, user.profileId),
    )!;
  }
}
