import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { findDatabaseError } from '../common/database-exception.filter.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import {
  caseProposals,
  cases,
  hitlRequests,
  obligationOccurrences as occurrences,
  obligations,
  proposalApplications as applications,
} from '../database/schema/index.js';
import { ObligationsService } from '../obligations/obligations.service.js';
import { OccurrencesService } from '../obligations/occurrences.service.js';
import { type CaseRow, lockCase } from './case-lifecycle.js';
import { CASE_NOT_FOUND } from './cases.service.js';
import type { ProposalApplicationResponseDto } from './dto/proposal-application.dto.js';
import {
  type ParsedProposalAction,
  parseProposalAction,
} from './proposal-actions.js';

const COMPONENT = 'api.proposal-applications';
export const PROPOSAL_NOT_FOUND = 'Propuesta no encontrada en este caso';

/** Datos de trazabilidad añadidos a la auditoría de los registros creados. */
type Trace = Record<string, unknown>;

interface StoredDecision {
  outcome?: string;
}
interface StoredOptions {
  choices?: unknown[];
}

/**
 * Aplica a los datos de negocio una propuesta de IA aprobada por el usuario.
 *
 * - Solo ejecuta las acciones de `PROPOSAL_ACTIONS`, con los datos aprobados
 *   (el cliente no envía datos) y las mismas reglas de los servicios de
 *   obligaciones, que se reutilizan dentro de la misma transacción.
 * - Exactamente una vez: el caso se bloquea (`FOR UPDATE`) y
 *   `proposal_applications.proposal_id` es único; un reintento devuelve la
 *   aplicación existente sin crear nada.
 * - Todo (registros creados, aplicación y auditoría) es una transacción.
 * - Nunca confirma pagos, cobros ni contratos ni cambia propietarios.
 */
@Injectable()
export class ProposalApplicationService {
  private readonly logger = new Logger(ProposalApplicationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly obligationsService: ObligationsService,
    private readonly occurrencesService: OccurrencesService,
  ) {}

  async apply(
    user: AuthenticatedUser,
    caseId: string,
    proposalId: string,
  ): Promise<ProposalApplicationResponseDto> {
    const [owned] = await this.db
      .select({ correlationId: cases.correlationId })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.ownerId, user.profileId)));
    if (!owned) throw new NotFoundException(CASE_NOT_FOUND);

    try {
      return await this.db.transaction((tx) =>
        this.applyLocked(tx, user, caseId, proposalId),
      );
    } catch (error) {
      // Carrera entre conexiones distintas: la otra transacción ya aplicó.
      if (
        findDatabaseError(error)?.constraint ===
        'proposal_applications_proposal_unique'
      ) {
        const existing = await this.findApplication(this.db, proposalId);
        if (existing) return existing;
      }
      await this.recordRejection(
        user,
        owned.correlationId,
        caseId,
        proposalId,
        error,
      );
      throw error;
    }
  }

  private async applyLocked(
    tx: DbTransaction,
    user: AuthenticatedUser,
    caseId: string,
    proposalId: string,
  ): Promise<ProposalApplicationResponseDto> {
    // Orden de bloqueo del backend: caso → propuestas / revisiones.
    const caseRow = (await lockCase(tx, caseId))!;
    const [proposal] = await tx
      .select({
        id: caseProposals.id,
        version: caseProposals.version,
        reviewStatus: caseProposals.reviewStatus,
        proposedData: caseProposals.proposedData,
      })
      .from(caseProposals)
      .where(
        and(
          eq(caseProposals.id, proposalId),
          eq(caseProposals.caseId, caseId),
          eq(caseProposals.ownerId, user.profileId),
        ),
      );
    if (!proposal) throw new NotFoundException(PROPOSAL_NOT_FOUND);

    const existing = await this.findApplication(tx, proposalId);
    if (existing) return existing;

    if (caseRow.status === 'failed' || caseRow.status === 'cancelled') {
      throw new ConflictException(
        `El caso está cerrado como "${caseRow.status}"; la propuesta no puede aplicarse`,
      );
    }
    if (proposal.reviewStatus !== 'accepted') {
      throw new ConflictException(
        {
          pending_review: 'La propuesta aún no ha sido aprobada por el usuario',
          rejected: 'La propuesta fue rechazada; no puede aplicarse',
          superseded:
            'La propuesta fue reemplazada por una versión más reciente',
        }[proposal.reviewStatus] ?? 'La propuesta no está aprobada',
      );
    }
    const [newer] = await tx
      .select({ id: caseProposals.id })
      .from(caseProposals)
      .where(
        and(
          eq(caseProposals.caseId, caseId),
          sql`${caseProposals.version} > ${proposal.version}`,
        ),
      )
      .limit(1);
    if (newer) {
      throw new ConflictException(
        'Existe una versión más reciente de la propuesta; solo la última puede aplicarse',
      );
    }
    const hitlRequestId = await this.approvingReview(
      tx,
      user,
      caseId,
      proposalId,
    );
    if (caseRow.type !== 'household_obligation') {
      throw new ConflictException(
        'Las acciones permitidas solo aplican a casos de obligaciones del hogar',
      );
    }

    const parsed = await parseProposalAction(proposal.proposedData);
    const trace: Trace = {
      source: 'case_proposal',
      caseId,
      proposalId,
      proposalVersion: proposal.version,
      hitlRequestId,
    };
    const created = await this.execute(tx, user, caseRow, parsed, trace);

    const [application] = await tx
      .insert(applications)
      .values({
        proposalId,
        caseId,
        ownerId: user.profileId,
        hitlRequestId,
        action: parsed.action,
        obligationId: created.obligationId,
        occurrenceId: created.occurrenceId,
        appliedBy: user.profileId,
      })
      .returning({ id: applications.id });
    await this.audit.recordUserAction(tx, {
      profileId: user.profileId,
      correlationId: caseRow.correlationId,
      component: COMPONENT,
      action: 'case_proposal.apply',
      resource: 'case_proposal',
      resourceId: proposalId,
      details: {
        ...trace,
        applicationId: application!.id,
        action: parsed.action,
        obligationId: created.obligationId,
        occurrenceId: created.occurrenceId,
        createdObligation: created.createdObligation,
        occurrenceStatus: 'pending',
        humanApproval: true,
        appliedToBusinessData: true,
      },
    });
    return (await this.findApplication(tx, proposalId, false))!;
  }

  /**
   * Revisión `data_confirmation` aprobada explícitamente, del mismo caso y
   * vinculada a esta propuesta, decidida antes de su fecha límite. Una
   * revisión con alternativas no autoriza la aplicación automática: la
   * alternativa elegida no forma parte de la propuesta aprobada.
   */
  private async approvingReview(
    tx: DbTransaction,
    user: AuthenticatedUser,
    caseId: string,
    proposalId: string,
  ): Promise<string> {
    const [review] = await tx
      .select({
        id: hitlRequests.id,
        decisionType: hitlRequests.decisionType,
        options: hitlRequests.options,
        decision: hitlRequests.decision,
        inTime: sql<boolean>`(${hitlRequests.respondedAt} < ${hitlRequests.dueAt})`,
      })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.caseId, caseId),
          eq(hitlRequests.proposalId, proposalId),
          eq(hitlRequests.ownerId, user.profileId),
          eq(hitlRequests.assignedTo, user.profileId),
          eq(hitlRequests.status, 'approved'),
        ),
      )
      .orderBy(desc(hitlRequests.respondedAt))
      .limit(1);
    if (!review || (review.decision as StoredDecision).outcome !== 'approved') {
      throw new ConflictException(
        'La propuesta no tiene una aprobación humana válida vinculada',
      );
    }
    if (!review.inTime) {
      throw new ConflictException('La aprobación se registró fuera de plazo');
    }
    if (review.decisionType !== 'data_confirmation') {
      throw new ConflictException(
        'Solo una revisión de confirmación de datos autoriza la aplicación',
      );
    }
    if (((review.options as StoredOptions).choices ?? []).length > 0) {
      throw new ConflictException(
        'La revisión tenía alternativas; la propuesta debe completarse manualmente',
      );
    }
    return review.id;
  }

  private async execute(
    tx: DbTransaction,
    user: AuthenticatedUser,
    caseRow: CaseRow,
    parsed: ParsedProposalAction,
    trace: Trace,
  ): Promise<{
    obligationId: string;
    occurrenceId: string;
    createdObligation: boolean;
  }> {
    const correlationId = caseRow.correlationId;
    if (parsed.action === 'create_obligation_occurrence') {
      const { obligationId, currency, ...occurrence } = parsed.data;
      if (caseRow.obligationId && caseRow.obligationId !== obligationId) {
        throw new BadRequestException(
          'La propuesta se refiere a una obligación distinta de la del caso',
        );
      }
      const expected = await this.occurrencesService.obligationCurrency(
        tx,
        user,
        obligationId,
      );
      if (currency !== undefined && currency !== expected) {
        throw new BadRequestException(
          `La moneda propuesta no coincide con la de la obligación (${expected}); no se convierten monedas`,
        );
      }
      await this.assertNewPeriod(tx, obligationId, occurrence.periodStart);
      const row = await this.occurrencesService.insertPending(
        tx,
        user,
        correlationId,
        obligationId,
        occurrence,
        trace,
      );
      return { obligationId, occurrenceId: row.id, createdObligation: false };
    }

    if (caseRow.obligationId) {
      throw new ConflictException(
        'El caso ya se refiere a una obligación existente; no se crea otra',
      );
    }
    const { obligation, occurrence } = parsed.data;
    const [duplicate] = await tx
      .select({ id: obligations.id })
      .from(obligations)
      .where(
        and(
          eq(obligations.ownerId, user.profileId),
          ne(obligations.status, 'archived'),
          sql`lower(${obligations.providerName}) = lower(${obligation.providerName})`,
          sql`lower(${obligations.concept}) = lower(${obligation.concept})`,
        ),
      )
      .limit(1);
    if (duplicate) {
      throw new ConflictException(
        'Ya existe una obligación con el mismo proveedor y concepto; aplica un período sobre ella',
      );
    }
    const created = await this.obligationsService.insertObligation(
      tx,
      user,
      correlationId,
      { ...obligation, status: 'active' },
      trace,
    );
    const row = await this.occurrencesService.insertPending(
      tx,
      user,
      correlationId,
      created.id,
      occurrence,
      trace,
    );
    return {
      obligationId: created.id,
      occurrenceId: row.id,
      createdObligation: true,
    };
  }

  /** Un período existente nunca se altera ni se duplica. */
  private async assertNewPeriod(
    tx: DbTransaction,
    obligationId: string,
    periodStart: string,
  ): Promise<void> {
    const [exists] = await tx
      .select({ id: occurrences.id })
      .from(occurrences)
      .where(
        and(
          eq(occurrences.obligationId, obligationId),
          eq(occurrences.periodStart, periodStart),
        ),
      );
    if (exists) {
      throw new ConflictException(
        'Ya existe un período con esa fecha de inicio; no se modifica ni se duplica',
      );
    }
  }

  private async findApplication(
    executor: Database | DbTransaction,
    proposalId: string,
    alreadyApplied = true,
  ): Promise<ProposalApplicationResponseDto | null> {
    const [row] = await executor
      .select({
        caseId: applications.caseId,
        proposalId: applications.proposalId,
        proposalVersion: caseProposals.version,
        hitlRequestId: applications.hitlRequestId,
        action: applications.action,
        appliedAt: applications.appliedAt,
        obligationId: applications.obligationId,
        occurrenceId: applications.occurrenceId,
        occurrenceStatus: occurrences.status,
        correlationId: cases.correlationId,
      })
      .from(applications)
      .innerJoin(caseProposals, eq(caseProposals.id, applications.proposalId))
      .innerJoin(cases, eq(cases.id, applications.caseId))
      .innerJoin(occurrences, eq(occurrences.id, applications.occurrenceId))
      .where(eq(applications.proposalId, proposalId));
    if (!row) return null;
    return {
      caseId: row.caseId,
      proposalId: row.proposalId,
      proposalVersion: row.proposalVersion,
      hitlRequestId: row.hitlRequestId,
      action: row.action,
      status: 'applied',
      alreadyApplied,
      appliedAt: row.appliedAt,
      resource: {
        type: 'obligation_occurrence',
        id: row.occurrenceId,
        obligationId: row.obligationId,
        status: row.occurrenceStatus,
      },
      createdObligationId:
        row.action === 'create_obligation_with_occurrence'
          ? row.obligationId
          : null,
      correlationId: row.correlationId,
    };
  }

  /**
   * Registra el rechazo (resultado `failure`) en una transacción aparte: la
   * de negocio ya se revirtió. Sin datos de la propuesta, solo el motivo.
   * Si la auditoría falla, se informa el error original.
   */
  private async recordRejection(
    user: AuthenticatedUser,
    correlationId: string,
    caseId: string,
    proposalId: string,
    error: unknown,
  ): Promise<void> {
    const httpStatus =
      error instanceof HttpException
        ? error.getStatus()
        : findDatabaseError(error)?.code === '23505'
          ? 409
          : null;
    if (httpStatus === null || httpStatus >= 500) return;
    const reason =
      error instanceof HttpException
        ? [error.getResponse()].flatMap((r) =>
            typeof r === 'string' ? r : (r as { message?: unknown }).message,
          )
        : ['Conflicto con datos existentes'];
    try {
      await this.db.transaction((tx) =>
        this.audit.recordUserAction(tx, {
          profileId: user.profileId,
          correlationId,
          component: COMPONENT,
          action: 'case_proposal.apply',
          resource: 'case_proposal',
          resourceId: proposalId,
          result: 'failure',
          details: {
            caseId,
            httpStatus,
            reason: reason.flat().map(String).join('; ').slice(0, 300),
            appliedToBusinessData: false,
          },
        }),
      );
    } catch (auditError) {
      this.logger.warn(
        `No se pudo auditar el rechazo de la aplicación: ${(auditError as Error).message}`,
      );
    }
  }
}
