import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import {
  assertDateOrder,
  assertHasChanges,
  diffPatch,
} from '../common/dto-helpers.js';
import { offsetOf, type Page } from '../common/pagination.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import { rentCharges as charges, rentals } from '../database/schema/index.js';
import {
  type ConfirmRentChargeDto,
  type CreateRentChargeDto,
  type ListRentChargesQueryDto,
  OPEN_RENT_CHARGE_STATUSES,
  type RentChargeResponseDto,
  type UpdateRentChargeDto,
} from './dto/rent-charge.dto.js';
import { RENTAL_NOT_FOUND } from './rentals.service.js';

const COMPONENT = 'api.rent-charges';
export const RENT_CHARGE_NOT_FOUND = 'Cobro no encontrado';

const columns = {
  id: charges.id,
  rentalId: charges.rentalId,
  periodStart: charges.periodStart,
  periodEnd: charges.periodEnd,
  expectedAmount: charges.expectedAmount,
  currency: charges.currency,
  dueDate: charges.dueDate,
  status: charges.status,
  confirmedAt: charges.confirmedAt,
  confirmedBy: charges.confirmedBy,
  confirmationEvidence: charges.confirmationEvidence,
  createdAt: charges.createdAt,
  updatedAt: charges.updatedAt,
};

const isOpen = (status: string) =>
  (OPEN_RENT_CHARGE_STATUSES as readonly string[]).includes(status);

/**
 * Cobros de un arriendo. Cada consulta exige que el arriendo y el cobro
 * pertenezcan al propietario autenticado. Los cobros recibidos o anulados son
 * inmutables; solo /confirm registra una recepción, y nunca por el paso del tiempo.
 */
@Injectable()
export class RentChargesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    rentalId: string,
    query: ListRentChargesQueryDto,
  ): Promise<Page<RentChargeResponseDto>> {
    await this.findRental(this.db, user, rentalId);

    const filters: SQL[] = [
      eq(charges.rentalId, rentalId),
      eq(charges.ownerId, user.profileId),
    ];
    if (query.status) filters.push(eq(charges.status, query.status));
    if (query.periodFrom)
      filters.push(gte(charges.periodStart, query.periodFrom));
    if (query.periodTo) filters.push(lte(charges.periodStart, query.periodTo));
    const where = and(...filters);

    const [items, [total]] = await Promise.all([
      this.db
        .select(columns)
        .from(charges)
        .where(where)
        .orderBy(
          asc(charges.dueDate),
          asc(charges.periodStart),
          asc(charges.id),
        )
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(charges).where(where),
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
    rentalId: string,
    id: string,
  ): Promise<RentChargeResponseDto> {
    const [row] = await this.db
      .select(columns)
      .from(charges)
      .where(this.ownedCharge(user, rentalId, id));
    if (!row) throw new NotFoundException(RENT_CHARGE_NOT_FOUND);
    return row;
  }

  async create(
    user: AuthenticatedUser,
    correlationId: string,
    rentalId: string,
    dto: CreateRentChargeDto,
  ): Promise<RentChargeResponseDto> {
    assertDateOrder(dto.periodStart, dto.periodEnd, 'periodStart', 'periodEnd');
    return this.db.transaction(async (tx) => {
      const rental = await this.findRental(tx, user, rentalId, true);
      if (rental.status === 'ended') {
        throw new ConflictException(
          'El arriendo está terminado y no admite nuevos cobros',
        );
      }
      assertWithinRental(rental, dto.periodStart);

      // El monto y la moneda se copian al cobro: cambios futuros del canon no
      // alteran este valor histórico.
      const [row] = await tx
        .insert(charges)
        .values({
          rentalId,
          ownerId: user.profileId,
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd,
          dueDate: dto.dueDate,
          expectedAmount: dto.expectedAmount ?? rental.expectedAmount,
          currency: rental.currency,
          status: 'expected',
        })
        .returning(columns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'rent_charge.create',
        resource: 'rent_charge',
        resourceId: row!.id,
        details: { rentalId, periodStart: row!.periodStart },
      });
      return row!;
    });
  }

  async update(
    user: AuthenticatedUser,
    correlationId: string,
    rentalId: string,
    id: string,
    dto: UpdateRentChargeDto,
  ): Promise<RentChargeResponseDto> {
    assertHasChanges(dto);
    return this.db.transaction(async (tx) => {
      const current = await this.lockCharge(tx, user, rentalId, id);
      if (!isOpen(current.status)) {
        throw new ConflictException(
          'Solo se pueden editar cobros esperados, pendientes o vencidos',
        );
      }

      const patch = {
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        dueDate: dto.dueDate,
        expectedAmount: dto.expectedAmount,
        status: dto.status,
      };
      assertDateOrder(
        patch.periodStart ?? current.periodStart,
        patch.periodEnd ?? current.periodEnd,
        'periodStart',
        'periodEnd',
      );
      const { changes, values } = diffPatch(current, patch);
      if (changes.length === 0) return current;
      if (values.periodStart) {
        assertWithinRental(
          await this.findRental(tx, user, rentalId, true),
          values.periodStart,
        );
      }

      const [row] = await tx
        .update(charges)
        .set(values)
        .where(
          and(
            this.ownedCharge(user, rentalId, id),
            inArray(charges.status, [...OPEN_RENT_CHARGE_STATUSES]),
          ),
        )
        .returning(columns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'rent_charge.update',
        resource: 'rent_charge',
        resourceId: id,
        details: {
          rentalId,
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
   * Confirmación humana de que el propietario recibió el cobro.
   * - Desde `expected`/`pending`/`overdue`: pasa a `received` con
   *   `confirmed_by` (JWT), `confirmed_at` (reloj de PostgreSQL) y la evidencia
   *   aportada, junto con su evento de auditoría.
   * - Repetir la confirmación con la misma evidencia devuelve el cobro sin
   *   cambios (idempotente); con otra evidencia, o sobre un cobro anulado, 409.
   * El bloqueo `FOR UPDATE` serializa solicitudes concurrentes sobre el mismo cobro.
   */
  async confirm(
    user: AuthenticatedUser,
    correlationId: string,
    rentalId: string,
    id: string,
    dto: ConfirmRentChargeDto,
  ): Promise<RentChargeResponseDto> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockCharge(tx, user, rentalId, id);

      if (!isOpen(current.status)) {
        if (
          current.status === 'received' &&
          current.confirmationEvidence === dto.evidence
        ) {
          return current;
        }
        throw new ConflictException(
          current.status === 'cancelled'
            ? 'El cobro está anulado y no puede confirmarse'
            : 'El cobro ya fue confirmado como recibido con otra evidencia',
        );
      }

      const [row] = await tx
        .update(charges)
        .set({
          status: 'received',
          confirmedBy: user.profileId,
          confirmedAt: sql`now()`,
          confirmationEvidence: dto.evidence,
        })
        .where(
          and(
            this.ownedCharge(user, rentalId, id),
            inArray(charges.status, [...OPEN_RENT_CHARGE_STATUSES]),
          ),
        )
        .returning(columns);
      if (!row) {
        throw new ConflictException(
          'El cobro cambió de estado; vuelve a consultarlo',
        );
      }
      // La evidencia no se copia a la auditoría: queda en el propio cobro.
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'rent_charge.confirm',
        resource: 'rent_charge',
        resourceId: id,
        details: {
          rentalId,
          humanConfirmation: true,
          statusFrom: current.status,
          statusTo: row.status,
          hasEvidence: true,
        },
      });
      return row;
    });
  }

  private ownedCharge(user: AuthenticatedUser, rentalId: string, id: string) {
    return and(
      eq(charges.id, id),
      eq(charges.rentalId, rentalId),
      eq(charges.ownerId, user.profileId),
    );
  }

  private async lockCharge(
    tx: DbTransaction,
    user: AuthenticatedUser,
    rentalId: string,
    id: string,
  ) {
    const [row] = await tx
      .select(columns)
      .from(charges)
      .where(this.ownedCharge(user, rentalId, id))
      .for('update');
    if (!row) throw new NotFoundException(RENT_CHARGE_NOT_FOUND);
    return row;
  }

  private async findRental(
    executor: Database | DbTransaction,
    user: AuthenticatedUser,
    rentalId: string,
    lock = false,
  ) {
    const query = executor
      .select({
        status: rentals.status,
        expectedAmount: rentals.expectedAmount,
        currency: rentals.currency,
        startsOn: rentals.startsOn,
        endsOn: rentals.endsOn,
      })
      .from(rentals)
      .where(
        and(eq(rentals.id, rentalId), eq(rentals.ownerId, user.profileId)),
      );
    const [row] = lock ? await query.for('share') : await query;
    if (!row) throw new NotFoundException(RENTAL_NOT_FOUND);
    return row;
  }
}

/** El período debe iniciar dentro de la vigencia del arriendo. */
function assertWithinRental(
  rental: { startsOn: string; endsOn: string | null },
  periodStart: string,
): void {
  if (
    periodStart < rental.startsOn ||
    (rental.endsOn !== null && periodStart > rental.endsOn)
  ) {
    throw new BadRequestException(
      'periodStart debe estar dentro de la vigencia del arriendo',
    );
  }
}
