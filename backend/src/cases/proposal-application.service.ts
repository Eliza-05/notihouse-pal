import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { ProcessActor } from '../audit/process-actor.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { findDatabaseError } from '../common/database-exception.filter.js';
import { assertDateOrder, diffPatch } from '../common/dto-helpers.js';
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
  rentals,
} from '../database/schema/index.js';
import { clampedDayInMonth, yearMonthOf } from '../due-dates/calendar.js';
import { DueDateEvaluationService } from '../due-dates/due-date-evaluation.service.js';
import { ObligationsService } from '../obligations/obligations.service.js';
import { OccurrencesService } from '../obligations/occurrences.service.js';
import { RecurrenceService } from '../recurrence/recurrence.service.js';
import { RentalsService } from '../rentals/rentals.service.js';
import { type CaseRow, lockCase } from './case-lifecycle.js';
import { CASE_NOT_FOUND } from './cases.service.js';
import type { ProposalApplicationResponseDto } from './dto/proposal-application.dto.js';
import {
  type CreateRecurringObligationActionData,
  type CreateRecurringRentalActionData,
  type ParsedProposalAction,
  parseProposalAction,
  type ProposalAction,
  type UpdateObligationScheduleActionData,
  type UpdateOccurrenceDetailsActionData,
} from './proposal-actions.js';
import {
  contradicts,
  factsOf,
  type ProposalFacts,
} from './source-contradictions.js';

/** Las reglas de E12 y el tipo de caso (D7) solo aplican a estas dos acciones originales. */
const DOCUMENT_DERIVED_ACTIONS: readonly ProposalAction[] = [
  'create_obligation_occurrence',
  'create_obligation_with_occurrence',
];

interface ExecutionResult {
  obligationId: string | null;
  occurrenceId: string | null;
  rentalId: string | null;
  createdObligation: boolean;
  createdRental: boolean;
  recalculatedOccurrenceId?: string | null;
}

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
    private readonly rentalsService: RentalsService,
    private readonly recurrenceService: RecurrenceService,
    private readonly dueDates: DueDateEvaluationService,
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
        source: caseProposals.source,
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

    // Una transcripción es solo texto de entrada: la operación aplicable debe
    // venir de una propuesta posterior de interpretación con su propia revisión.
    if (proposal.source === 'stt') {
      throw new BadRequestException(
        'Una transcripción (stt) no se aplica; registra una propuesta de interpretación',
      );
    }

    const parsed = await parseProposalAction(proposal.proposedData);
    // D7: el tipo de caso se elige al enviar el mensaje, antes de interpretar;
    // solo las dos acciones originales (documentos/voz de obligaciones) lo exigen.
    if (
      DOCUMENT_DERIVED_ACTIONS.includes(parsed.action) &&
      caseRow.type !== 'household_obligation'
    ) {
      throw new ConflictException(
        'Las acciones permitidas solo aplican a casos de obligaciones del hogar',
      );
    }
    if (
      parsed.action === 'create_obligation_occurrence' ||
      parsed.action === 'create_obligation_with_occurrence'
    ) {
      await this.assertNoContradictingSource(tx, user, caseId, parsed);
    }
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
        rentalId: created.rentalId,
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
        rentalId: created.rentalId,
        createdObligation: created.createdObligation,
        createdRental: created.createdRental,
        ...(created.occurrenceId ? { occurrenceStatus: 'pending' } : {}),
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
  ): Promise<ExecutionResult> {
    const correlationId = caseRow.correlationId;
    if (parsed.action === 'create_recurring_obligation') {
      return this.executeCreateRecurringObligation(
        tx,
        user,
        parsed,
        trace,
        correlationId,
      );
    }
    if (parsed.action === 'update_obligation_schedule') {
      return this.executeUpdateObligationSchedule(
        tx,
        user,
        parsed,
        trace,
        correlationId,
      );
    }
    if (parsed.action === 'update_occurrence_details') {
      return this.executeUpdateOccurrenceDetails(tx, user, parsed);
    }
    if (parsed.action === 'create_recurring_rental') {
      return this.executeCreateRecurringRental(
        tx,
        user,
        parsed,
        trace,
        correlationId,
      );
    }
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
      return {
        obligationId,
        occurrenceId: row.id,
        rentalId: null,
        createdObligation: false,
        createdRental: false,
      };
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
      rentalId: null,
      createdObligation: true,
      createdRental: false,
    };
  }

  /**
   * `create_recurring_obligation`: definición nueva con `autoGenerate = true`;
   * el recurso de la aplicación es la obligación (sin período propio). El
   * primer período se genera de inmediato con la misma función del barrido
   * programado (§19.4, punto 6), como un efecto auditado por separado.
   */
  private async executeCreateRecurringObligation(
    tx: DbTransaction,
    user: AuthenticatedUser,
    parsed: { data: CreateRecurringObligationActionData },
    trace: Trace,
    correlationId: string,
  ): Promise<ExecutionResult> {
    const { obligation } = parsed.data;
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
      { ...obligation, status: 'active', autoGenerate: true },
      trace,
    );
    const ref = this.dueDates.reference();
    await this.recurrenceService.generateForObligation(
      tx,
      {
        id: created.id,
        ownerId: user.profileId,
        frequency: created.frequency,
        dueDay: created.dueDay,
        startsOn: created.startsOn,
        createdAt: created.createdAt,
        expectedAmount: created.expectedAmount,
        currency: created.currency,
      },
      ref.today,
      this.dueDates.rules.timeZone,
      { kind: 'user', profileId: user.profileId },
      correlationId,
    );
    return {
      obligationId: created.id,
      occurrenceId: null,
      rentalId: null,
      createdObligation: true,
      createdRental: false,
    };
  }

  /**
   * `update_obligation_schedule` (§19.5): solo `dueDay`, `reminderDaysBefore`
   * y `expectedAmount`; control optimista contra `expected`; si `dueDay`
   * cambia, el período `pending` vigente recalcula su `dueDate` (D12) salvo
   * que el nuevo vencimiento quede en el pasado (entonces se conserva y rige
   * desde el ciclo siguiente, que ya generará con el nuevo día).
   */
  private async executeUpdateObligationSchedule(
    tx: DbTransaction,
    user: AuthenticatedUser,
    parsed: { data: UpdateObligationScheduleActionData },
    trace: Trace,
    correlationId: string,
  ): Promise<ExecutionResult> {
    const { obligationId, expected, changes } = parsed.data;
    const [current] = await tx
      .select({
        dueDay: obligations.dueDay,
        reminderDaysBefore: obligations.reminderDaysBefore,
        expectedAmount: obligations.expectedAmount,
        status: obligations.status,
      })
      .from(obligations)
      .where(
        and(eq(obligations.id, obligationId), eq(obligations.ownerId, user.profileId)),
      )
      .for('update');
    if (!current) {
      throw new NotFoundException('Obligación no encontrada');
    }
    if (current.status === 'archived') {
      throw new ConflictException(
        'La obligación está archivada y no admite cambios',
      );
    }
    for (const key of ['dueDay', 'reminderDaysBefore', 'expectedAmount'] as const) {
      if (expected[key] !== undefined && expected[key] !== current[key]) {
        throw new ConflictException(
          'La obligación cambió desde que se preparó la propuesta; revísala de nuevo',
        );
      }
    }
    const { changes: realChanges, values } = diffPatch(current, {
      dueDay: changes.dueDay,
      reminderDaysBefore: changes.reminderDaysBefore,
      expectedAmount: changes.expectedAmount,
    });
    if (realChanges.length === 0) {
      throw new BadRequestException('La propuesta no contiene cambios reales');
    }
    const [updated] = await tx
      .update(obligations)
      .set(values)
      .where(
        and(eq(obligations.id, obligationId), eq(obligations.ownerId, user.profileId)),
      )
      .returning({ dueDay: obligations.dueDay });
    await this.audit.recordUserAction(tx, {
      profileId: user.profileId,
      correlationId,
      component: COMPONENT,
      action: 'obligation.update',
      resource: 'obligation',
      resourceId: obligationId,
      details: { changes: realChanges, ...trace },
    });

    let recalculatedOccurrenceId: string | null = null;
    if (realChanges.includes('dueDay') && updated!.dueDay != null) {
      recalculatedOccurrenceId = await this.recalculatePendingDueDate(
        tx,
        user,
        obligationId,
        updated!.dueDay,
        trace,
        correlationId,
      );
    }
    return {
      obligationId,
      occurrenceId: null,
      rentalId: null,
      createdObligation: false,
      createdRental: false,
      recalculatedOccurrenceId,
    };
  }

  /**
   * D12: el período `pending` (nunca `overdue`, que conserva su fecha
   * incumplida) recalcula su `dueDate` con el nuevo día dentro del mes de su
   * `periodStart`, solo si el resultado no queda en el pasado.
   */
  private async recalculatePendingDueDate(
    tx: DbTransaction,
    user: AuthenticatedUser,
    obligationId: string,
    newDueDay: number,
    trace: Trace,
    correlationId: string,
  ): Promise<string | null> {
    const today = this.dueDates.reference().today;
    const pending = await tx
      .select({
        id: occurrences.id,
        periodStart: occurrences.periodStart,
      })
      .from(occurrences)
      .where(
        and(
          eq(occurrences.obligationId, obligationId),
          eq(occurrences.status, 'pending'),
        ),
      )
      .for('update');
    let recalculatedId: string | null = null;
    for (const occurrence of pending) {
      const newDueDate = clampedDayInMonth(
        yearMonthOf(occurrence.periodStart),
        newDueDay,
      );
      if (newDueDate < today) continue;
      await tx
        .update(occurrences)
        .set({ dueDate: newDueDate })
        .where(eq(occurrences.id, occurrence.id));
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'obligation_occurrence.update',
        resource: 'obligation_occurrence',
        resourceId: occurrence.id,
        details: { changes: ['dueDate'], newDueDate, ...trace },
      });
      recalculatedId = occurrence.id;
    }
    return recalculatedId;
  }

  /**
   * `update_occurrence_details`: aporta el monto o la fecha reales a un
   * período `pending` ya generado (§19.4, "llegada posterior de una
   * factura"). Nunca toca un período confirmado o anulado.
   */
  private async executeUpdateOccurrenceDetails(
    tx: DbTransaction,
    user: AuthenticatedUser,
    parsed: { data: UpdateOccurrenceDetailsActionData },
  ): Promise<ExecutionResult> {
    const { obligationId, occurrenceId, amount, dueDate } = parsed.data;
    if (amount === undefined && dueDate === undefined) {
      throw new BadRequestException(
        'La propuesta no contiene amount ni dueDate para actualizar',
      );
    }
    const [current] = await tx
      .select({ id: occurrences.id, status: occurrences.status })
      .from(occurrences)
      .where(
        and(
          eq(occurrences.id, occurrenceId),
          eq(occurrences.obligationId, obligationId),
          eq(occurrences.ownerId, user.profileId),
        ),
      )
      .for('update');
    if (!current) {
      throw new NotFoundException('Período no encontrado para esa obligación');
    }
    if (current.status !== 'pending') {
      throw new ConflictException(
        'El período no está pendiente; no se modifica un período confirmado o anulado',
      );
    }
    await tx
      .update(occurrences)
      .set({
        ...(amount !== undefined ? { amount } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
      })
      .where(eq(occurrences.id, occurrenceId));
    return {
      obligationId,
      occurrenceId,
      rentalId: null,
      createdObligation: false,
      createdRental: false,
    };
  }

  /**
   * `create_recurring_rental`: arriendo nuevo con `autoGenerate = true`; el
   * recurso de la aplicación es el arriendo. El primer cobro se genera de
   * inmediato con la misma función del barrido programado (§19.4, punto 6).
   */
  private async executeCreateRecurringRental(
    tx: DbTransaction,
    user: AuthenticatedUser,
    parsed: { data: CreateRecurringRentalActionData },
    trace: Trace,
    correlationId: string,
  ): Promise<ExecutionResult> {
    const created = await this.rentalsService.insertRental(
      tx,
      user,
      correlationId,
      { ...parsed.data.rental, status: 'active', autoGenerate: true },
      trace,
    );
    const ref = this.dueDates.reference();
    await this.recurrenceService.generateForRental(
      tx,
      {
        id: created.id,
        ownerId: user.profileId,
        dueDay: created.dueDay,
        startsOn: created.startsOn,
        endsOn: created.endsOn,
        expectedAmount: created.expectedAmount,
        currency: created.currency,
      },
      ref.today,
      { kind: 'user', profileId: user.profileId },
      correlationId,
    );
    return {
      obligationId: null,
      occurrenceId: null,
      rentalId: created.id,
      createdObligation: false,
      createdRental: true,
    };
  }

  /**
   * E12: otra fuente abierta (otro caso del mismo usuario, sin aplicar ni
   * rechazar) describe la misma obligación y período con un monto o una fecha
   * distintos. No se elige ninguna: 409 con ambas fuentes hasta que la persona
   * rechace la incorrecta. Las transcripciones (stt) son solo evidencia.
   */
  private async assertNoContradictingSource(
    tx: DbTransaction,
    user: AuthenticatedUser,
    caseId: string,
    parsed: Extract<
      ParsedProposalAction,
      {
        action:
          | 'create_obligation_occurrence'
          | 'create_obligation_with_occurrence';
      }
    >,
  ): Promise<void> {
    let target: ProposalFacts;
    let provider: string | null;
    if (parsed.action === 'create_obligation_occurrence') {
      const [obligation] = await tx
        .select({ providerName: obligations.providerName })
        .from(obligations)
        .where(
          and(
            eq(obligations.id, parsed.data.obligationId),
            eq(obligations.ownerId, user.profileId),
          ),
        );
      provider = obligation?.providerName ?? null;
      target = {
        obligationId: parsed.data.obligationId,
        providerName: provider,
        amount: parsed.data.amount ?? null,
        dueDate: parsed.data.dueDate,
        periodStart: parsed.data.periodStart,
      };
    } else {
      provider = parsed.data.obligation.providerName;
      target = {
        obligationId: null,
        providerName: provider,
        amount: parsed.data.occurrence.amount ?? null,
        dueDate: parsed.data.occurrence.dueDate,
        periodStart: parsed.data.occurrence.periodStart,
      };
    }
    const others = await tx
      .select({
        id: caseProposals.id,
        caseId: caseProposals.caseId,
        source: cases.source,
        proposedData: caseProposals.proposedData,
      })
      .from(caseProposals)
      .innerJoin(cases, eq(cases.id, caseProposals.caseId))
      .leftJoin(applications, eq(applications.proposalId, caseProposals.id))
      .where(
        and(
          eq(caseProposals.ownerId, user.profileId),
          ne(caseProposals.caseId, caseId),
          inArray(caseProposals.reviewStatus, ['pending_review', 'accepted']),
          ne(caseProposals.source, 'stt'),
          isNull(applications.id),
          notInArray(cases.status, ['failed', 'cancelled']),
        ),
      )
      .orderBy(desc(caseProposals.createdAt))
      .limit(50);
    const conflicts = others.flatMap((other) => {
      const facts = factsOf(other.proposedData);
      return facts && contradicts(target, provider, facts)
        ? [
            {
              caseId: other.caseId,
              proposalId: other.id,
              source: other.source,
              amount: facts.amount,
              dueDate: facts.dueDate,
            },
          ]
        : [];
    });
    if (conflicts.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'CONTRADICTING_SOURCE',
        message:
          'Otra fuente describe esta misma obligación con datos distintos. Revisa ambas y rechaza la incorrecta antes de aplicar; no se registró nada.',
        proposed: { amount: target.amount, dueDate: target.dueDate },
        conflicts: conflicts.slice(0, 5),
      });
    }
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
        rentalId: applications.rentalId,
        occurrenceStatus: occurrences.status,
        obligationStatus: obligations.status,
        rentalStatus: rentals.status,
        correlationId: cases.correlationId,
      })
      .from(applications)
      .innerJoin(caseProposals, eq(caseProposals.id, applications.proposalId))
      .innerJoin(cases, eq(cases.id, applications.caseId))
      .leftJoin(occurrences, eq(occurrences.id, applications.occurrenceId))
      .leftJoin(obligations, eq(obligations.id, applications.obligationId))
      .leftJoin(rentals, eq(rentals.id, applications.rentalId))
      .where(eq(applications.proposalId, proposalId));
    if (!row) return null;
    const resource: ProposalApplicationResponseDto['resource'] =
      row.occurrenceId && row.occurrenceStatus
        ? {
            type: 'obligation_occurrence',
            id: row.occurrenceId,
            obligationId: row.obligationId!,
            status: row.occurrenceStatus,
          }
        : row.obligationId && row.obligationStatus
          ? {
              type: 'obligation',
              id: row.obligationId,
              obligationId: row.obligationId,
              status: row.obligationStatus,
            }
          : {
              type: 'rental',
              id: row.rentalId!,
              obligationId: null,
              status: row.rentalStatus!,
            };
    return {
      caseId: row.caseId,
      proposalId: row.proposalId,
      proposalVersion: row.proposalVersion,
      hitlRequestId: row.hitlRequestId,
      action: row.action,
      status: 'applied',
      alreadyApplied,
      appliedAt: row.appliedAt,
      resource,
      createdObligationId:
        row.action === 'create_obligation_with_occurrence' ||
        row.action === 'create_recurring_obligation'
          ? row.obligationId
          : null,
      createdRentalId: row.action === 'create_recurring_rental' ? row.rentalId : null,
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
