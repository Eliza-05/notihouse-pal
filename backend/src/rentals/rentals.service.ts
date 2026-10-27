import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import {
  assertDateOrder,
  assertHasChanges,
  diffPatch,
} from '../common/dto-helpers.js';
import { offsetOf, type Page } from '../common/pagination.js';
import { DRIZZLE, type Database } from '../database/database.constants.js';
import { rentals } from '../database/schema/index.js';
import { assertAssignableProperty } from '../properties/properties.service.js';
import type {
  CreateRentalDto,
  ListRentalsQueryDto,
  RentalResponseDto,
  UpdateRentalDto,
} from './dto/rental.dto.js';

const COMPONENT = 'api.rentals';
export const RENTAL_NOT_FOUND = 'Arriendo no encontrado';

export const rentalColumns = {
  id: rentals.id,
  propertyId: rentals.propertyId,
  tenantAlias: rentals.tenantAlias,
  expectedAmount: rentals.expectedAmount,
  currency: rentals.currency,
  dueDay: rentals.dueDay,
  startsOn: rentals.startsOn,
  endsOn: rentals.endsOn,
  status: rentals.status,
  createdAt: rentals.createdAt,
  updatedAt: rentals.updatedAt,
};

/**
 * Definiciones de arriendo. Toda consulta filtra por el propietario
 * autenticado; editar el arriendo nunca modifica sus cobros ni sus contratos.
 */
@Injectable()
export class RentalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListRentalsQueryDto,
  ): Promise<Page<RentalResponseDto>> {
    const filters: SQL[] = [eq(rentals.ownerId, user.profileId)];
    if (query.propertyId)
      filters.push(eq(rentals.propertyId, query.propertyId));
    if (query.status) filters.push(eq(rentals.status, query.status));
    const where = and(...filters);

    const [items, [total]] = await Promise.all([
      this.db
        .select(rentalColumns)
        .from(rentals)
        .where(where)
        .orderBy(asc(rentals.createdAt), asc(rentals.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(rentals).where(where),
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
    id: string,
  ): Promise<RentalResponseDto> {
    const [row] = await this.db
      .select(rentalColumns)
      .from(rentals)
      .where(and(eq(rentals.id, id), eq(rentals.ownerId, user.profileId)));
    if (!row) throw new NotFoundException(RENTAL_NOT_FOUND);
    return row;
  }

  async create(
    user: AuthenticatedUser,
    correlationId: string,
    dto: CreateRentalDto,
  ): Promise<RentalResponseDto> {
    assertDateOrder(dto.startsOn, dto.endsOn ?? null, 'startsOn', 'endsOn');
    return this.db.transaction(async (tx) => {
      await assertAssignableProperty(tx, user, dto.propertyId);
      const [row] = await tx
        .insert(rentals)
        .values({
          ownerId: user.profileId,
          propertyId: dto.propertyId,
          tenantAlias: dto.tenantAlias ?? null,
          expectedAmount: dto.expectedAmount,
          currency: dto.currency ?? 'COP',
          dueDay: dto.dueDay,
          startsOn: dto.startsOn,
          endsOn: dto.endsOn ?? null,
          status: dto.status ?? 'active',
        })
        .returning(rentalColumns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'rental.create',
        resource: 'rental',
        resourceId: row!.id,
        details: { propertyId: row!.propertyId, status: row!.status },
      });
      return row!;
    });
  }

  async update(
    user: AuthenticatedUser,
    correlationId: string,
    id: string,
    dto: UpdateRentalDto,
  ): Promise<RentalResponseDto> {
    assertHasChanges(dto);
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select(rentalColumns)
        .from(rentals)
        .where(and(eq(rentals.id, id), eq(rentals.ownerId, user.profileId)))
        .for('update');
      if (!current) throw new NotFoundException(RENTAL_NOT_FOUND);
      if (current.status === 'ended') {
        throw new ConflictException(
          'El arriendo está terminado y no admite cambios',
        );
      }

      const patch = {
        tenantAlias: dto.tenantAlias,
        expectedAmount: dto.expectedAmount,
        dueDay: dto.dueDay,
        startsOn: dto.startsOn,
        endsOn: dto.endsOn,
        status: dto.status,
      };
      assertDateOrder(
        patch.startsOn ?? current.startsOn,
        patch.endsOn === undefined ? current.endsOn : patch.endsOn,
        'startsOn',
        'endsOn',
      );
      const { changes, values } = diffPatch(current, patch);
      if (changes.length === 0) return current;

      // Solo se actualiza el arriendo: cada cobro conserva el monto con el que
      // se registró y los contratos no se modifican.
      const [row] = await tx
        .update(rentals)
        .set(values)
        .where(and(eq(rentals.id, id), eq(rentals.ownerId, user.profileId)))
        .returning(rentalColumns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'rental.update',
        resource: 'rental',
        resourceId: id,
        details: {
          changes,
          ...(changes.includes('status')
            ? { statusFrom: current.status, statusTo: row!.status }
            : {}),
        },
      });
      return row!;
    });
  }
}
