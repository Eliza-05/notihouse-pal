import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { assertHasChanges, diffPatch } from '../common/dto-helpers.js';
import { offsetOf, type Page } from '../common/pagination.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import {
  obligationOccurrences as occurrences,
  obligations,
} from '../database/schema/index.js';
import {
  type ConfirmOccurrenceDto,
  type CreateOccurrenceDto,
  type ListOccurrencesQueryDto,
  type OccurrenceResponseDto,
  OPEN_OCCURRENCE_STATUSES,
  type UpdateOccurrenceDto,
} from './dto/occurrence.dto.js';
import { OBLIGATION_NOT_FOUND } from './obligations.service.js';

const COMPONENT = 'api.obligation-occurrences';
export const OCCURRENCE_NOT_FOUND = 'Período no encontrado';

const columns = {
  id: occurrences.id,
  obligationId: occurrences.obligationId,
  periodStart: occurrences.periodStart,
  periodEnd: occurrences.periodEnd,
  amount: occurrences.amount,
  currency: occurrences.currency,
  dueDate: occurrences.dueDate,
  status: occurrences.status,
  confirmedAt: occurrences.confirmedAt,
  confirmedBy: occurrences.confirmedBy,
  confirmationReference: occurrences.confirmationReference,
  createdAt: occurrences.createdAt,
  updatedAt: occurrences.updatedAt,
};

const isOpen = (status: string) =>
  (OPEN_OCCURRENCE_STATUSES as readonly string[]).includes(status);

/**
 * Períodos de una obligación. Cada consulta exige que la obligación y el
 * período pertenezcan al propietario autenticado. Los períodos confirmados o
 * anulados son inmutables; solo /confirm registra un pago o atención.
 */
@Injectable()
export class OccurrencesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    obligationId: string,
    query: ListOccurrencesQueryDto,
  ): Promise<Page<OccurrenceResponseDto>> {
    await this.findObligation(this.db, user, obligationId);

    const filters: SQL[] = [
      eq(occurrences.obligationId, obligationId),
      eq(occurrences.ownerId, user.profileId),
    ];
    if (query.status) filters.push(eq(occurrences.status, query.status));
    const where = and(...filters);

    const [items, [total]] = await Promise.all([
      this.db
        .select(columns)
        .from(occurrences)
        .where(where)
        .orderBy(
          asc(occurrences.dueDate),
          asc(occurrences.periodStart),
          asc(occurrences.id),
        )
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(occurrences).where(where),
    ]);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: total!.n,
    };
  }

  async findOne(
    user: AuthenticatedUser,
    obligationId: string,
    id: string,
  ): Promise<OccurrenceResponseDto> {
    const [row] = await this.db
      .select(columns)
      .from(occurrences)
      .where(this.ownedOccurrence(user, obligationId, id));
    if (!row) throw new NotFoundException(OCCURRENCE_NOT_FOUND);
    return row;
  }

  async create(
    user: AuthenticatedUser,
    correlationId: string,
    obligationId: string,
    dto: CreateOccurrenceDto,
  ): Promise<OccurrenceResponseDto> {
    assertPeriodOrder(dto.periodStart, dto.periodEnd);
    return this.db.transaction(async (tx) => {
      const obligation = await this.findObligation(
        tx,
        user,
        obligationId,
        true,
      );
      if (obligation.status === 'archived') {
        throw new ConflictException(
          'La obligación está archivada y no admite nuevos períodos',
        );
      }

      // El monto y la moneda se copian al período: cambios futuros en la
      // definición no alteran este valor histórico.
      const [row] = await tx
        .insert(occurrences)
        .values({
          obligationId,
          ownerId: user.profileId,
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd,
          dueDate: dto.dueDate,
          amount: dto.amount ?? obligation.expectedAmount,
          currency: obligation.currency,
          status: 'pending',
        })
        .returning(columns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'obligation_occurrence.create',
        resource: 'obligation_occurrence',
        resourceId: row!.id,
        details: { obligationId, periodStart: row!.periodStart },
      });
      return row!;
    });
  }

  async update(
    user: AuthenticatedUser,
    correlationId: string,
    obligationId: string,
    id: string,
    dto: UpdateOccurrenceDto,
  ): Promise<OccurrenceResponseDto> {
    assertHasChanges(dto);
    return this.db.transaction(async (tx) => {
      const current = await this.lockOccurrence(tx, user, obligationId, id);
      if (!isOpen(current.status)) {
        throw new ConflictException(
          'Solo se pueden editar períodos pendientes o vencidos',
        );
      }

      const patch = {
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        dueDate: dto.dueDate,
        amount: dto.amount,
        status: dto.status,
      };
      assertPeriodOrder(
        patch.periodStart ?? current.periodStart,
        patch.periodEnd ?? current.periodEnd,
      );
      const { changes, values } = diffPatch(current, patch);
      if (changes.length === 0) return current;

      const [row] = await tx
        .update(occurrences)
        .set(values)
        .where(
          and(
            this.ownedOccurrence(user, obligationId, id),
            inArray(occurrences.status, [...OPEN_OCCURRENCE_STATUSES]),
          ),
        )
        .returning(columns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'obligation_occurrence.update',
        resource: 'obligation_occurrence',
        resourceId: id,
        details: {
          obligationId,
          changes,
          ...(changes.includes('status')
            ? { statusFrom: current.status, statusTo: row!.status }
            : {}),
        },
      });
      return row!;
    });
  }

  /**
   * Confirmación humana de pago o atención.
   * - Desde `pending`/`overdue`: registra el resultado, `confirmed_by` (JWT) y
   *   `confirmed_at` (reloj del servidor) junto con su evento de auditoría.
   * - Repetir la misma confirmación devuelve el período sin cambios (idempotente).
   * - Un resultado distinto o un período anulado responden 409.
   * El bloqueo `FOR UPDATE` serializa solicitudes concurrentes sobre el mismo período.
   */
  async confirm(
    user: AuthenticatedUser,
    correlationId: string,
    obligationId: string,
    id: string,
    dto: ConfirmOccurrenceDto,
  ): Promise<OccurrenceResponseDto> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockOccurrence(tx, user, obligationId, id);

      if (!isOpen(current.status)) {
        if (current.status === dto.result) return current;
        throw new ConflictException(
          current.status === 'cancelled'
            ? 'El período está anulado y no puede confirmarse'
            : `El período ya fue confirmado como "${current.status}"`,
        );
      }

      const [row] = await tx
        .update(occurrences)
        .set({
          status: dto.result,
          confirmedBy: user.profileId,
          confirmedAt: sql`now()`,
          confirmationReference: dto.reference ?? null,
        })
        .where(
          and(
            this.ownedOccurrence(user, obligationId, id),
            inArray(occurrences.status, [...OPEN_OCCURRENCE_STATUSES]),
          ),
        )
        .returning(columns);
      if (!row) {
        throw new ConflictException(
          'El período cambió de estado; vuelve a consultarlo',
        );
      }
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'obligation_occurrence.confirm',
        resource: 'obligation_occurrence',
        resourceId: id,
        details: {
          obligationId,
          humanConfirmation: true,
          statusFrom: current.status,
          statusTo: row.status,
          hasReference: row.confirmationReference !== null,
        },
      });
      return row;
    });
  }

  private ownedOccurrence(
    user: AuthenticatedUser,
    obligationId: string,
    id: string,
  ) {
    return and(
      eq(occurrences.id, id),
      eq(occurrences.obligationId, obligationId),
      eq(occurrences.ownerId, user.profileId),
    );
  }

  private async lockOccurrence(
    tx: DbTransaction,
    user: AuthenticatedUser,
    obligationId: string,
    id: string,
  ) {
    const [row] = await tx
      .select(columns)
      .from(occurrences)
      .where(this.ownedOccurrence(user, obligationId, id))
      .for('update');
    if (!row) throw new NotFoundException(OCCURRENCE_NOT_FOUND);
    return row;
  }

  private async findObligation(
    executor: Database | DbTransaction,
    user: AuthenticatedUser,
    obligationId: string,
    lock = false,
  ) {
    const query = executor
      .select({
        status: obligations.status,
        expectedAmount: obligations.expectedAmount,
        currency: obligations.currency,
      })
      .from(obligations)
      .where(
        and(
          eq(obligations.id, obligationId),
          eq(obligations.ownerId, user.profileId),
        ),
      );
    const [row] = lock ? await query.for('share') : await query;
    if (!row) throw new NotFoundException(OBLIGATION_NOT_FOUND);
    return row;
  }
}

function assertPeriodOrder(periodStart: string, periodEnd: string): void {
  // Fechas YYYY-MM-DD ya validadas: el orden lexicográfico coincide con el cronológico.
  if (periodEnd < periodStart) {
    throw new BadRequestException(
      'periodEnd no puede ser anterior a periodStart',
    );
  }
}
