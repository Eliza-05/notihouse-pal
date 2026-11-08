import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, ilike, isNull, or, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import {
  assertHasChanges,
  diffPatch,
  escapeLikePattern,
} from '../common/dto-helpers.js';
import { offsetOf, type Page } from '../common/pagination.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import { obligations } from '../database/schema/index.js';
import { assertAssignableProperty } from '../properties/properties.service.js';
import type {
  CreateObligationDto,
  ListObligationsQueryDto,
  ObligationResponseDto,
  UpdateObligationDto,
} from './dto/obligation.dto.js';

const COMPONENT = 'api.obligations';
export const OBLIGATION_NOT_FOUND = 'Obligación no encontrada';

export const obligationColumns = {
  id: obligations.id,
  propertyId: obligations.propertyId,
  providerName: obligations.providerName,
  concept: obligations.concept,
  category: obligations.category,
  expectedAmount: obligations.expectedAmount,
  currency: obligations.currency,
  frequency: obligations.frequency,
  dueDay: obligations.dueDay,
  reminderDaysBefore: obligations.reminderDaysBefore,
  startsOn: obligations.startsOn,
  status: obligations.status,
  autoGenerate: obligations.autoGenerate,
  createdAt: obligations.createdAt,
  updatedAt: obligations.updatedAt,
};

/**
 * Definiciones de obligaciones recurrentes. Toda consulta filtra por el
 * propietario autenticado; editar la definición nunca modifica los períodos
 * ya registrados.
 */
@Injectable()
export class ObligationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListObligationsQueryDto,
  ): Promise<Page<ObligationResponseDto>> {
    if (query.propertyId && query.unassigned) {
      throw new BadRequestException(
        'unassigned no es compatible con propertyId',
      );
    }
    const filters: SQL[] = [eq(obligations.ownerId, user.profileId)];
    if (query.propertyId)
      filters.push(eq(obligations.propertyId, query.propertyId));
    if (query.unassigned) filters.push(isNull(obligations.propertyId));
    if (query.status) filters.push(eq(obligations.status, query.status));
    if (query.category) filters.push(eq(obligations.category, query.category));
    if (query.q) {
      const pattern = `%${escapeLikePattern(query.q)}%`;
      filters.push(
        or(
          ilike(obligations.providerName, pattern),
          ilike(obligations.concept, pattern),
        )!,
      );
    }
    const where = and(...filters);

    const [items, [total]] = await Promise.all([
      this.db
        .select(obligationColumns)
        .from(obligations)
        .where(where)
        .orderBy(asc(obligations.createdAt), asc(obligations.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(obligations).where(where),
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
  ): Promise<ObligationResponseDto> {
    const [row] = await this.db
      .select(obligationColumns)
      .from(obligations)
      .where(
        and(eq(obligations.id, id), eq(obligations.ownerId, user.profileId)),
      );
    if (!row) throw new NotFoundException(OBLIGATION_NOT_FOUND);
    return row;
  }

  async create(
    user: AuthenticatedUser,
    correlationId: string,
    dto: CreateObligationDto,
  ): Promise<ObligationResponseDto> {
    return this.db.transaction((tx) =>
      this.insertObligation(tx, user, correlationId, dto),
    );
  }

  /**
   * Crea la definición dentro de `tx` y audita la creación. La reutiliza la
   * aplicación de propuestas aprobadas (`details` añade su trazabilidad).
   */
  async insertObligation(
    tx: DbTransaction,
    user: AuthenticatedUser,
    correlationId: string,
    dto: CreateObligationDto,
    details: Record<string, unknown> = {},
  ): Promise<ObligationResponseDto> {
    if (dto.propertyId) {
      await assertAssignableProperty(tx, user, dto.propertyId);
    }
    const [row] = await tx
      .insert(obligations)
      .values({
        ownerId: user.profileId,
        propertyId: dto.propertyId ?? null,
        providerName: dto.providerName,
        concept: dto.concept,
        category: dto.category,
        expectedAmount: dto.expectedAmount ?? null,
        currency: dto.currency ?? 'COP',
        frequency: dto.frequency ?? 'monthly',
        dueDay: dto.dueDay ?? null,
        reminderDaysBefore: dto.reminderDaysBefore ?? 3,
        startsOn: dto.startsOn ?? null,
        status: dto.status ?? 'active',
        autoGenerate: dto.autoGenerate ?? false,
      })
      .returning(obligationColumns);
    await this.audit.recordUserAction(tx, {
      profileId: user.profileId,
      correlationId,
      component: COMPONENT,
      action: 'obligation.create',
      resource: 'obligation',
      resourceId: row!.id,
      details: {
        propertyId: row!.propertyId,
        status: row!.status,
        ...details,
      },
    });
    return row!;
  }

  async update(
    user: AuthenticatedUser,
    correlationId: string,
    id: string,
    dto: UpdateObligationDto,
  ): Promise<ObligationResponseDto> {
    assertHasChanges(dto);
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select(obligationColumns)
        .from(obligations)
        .where(
          and(eq(obligations.id, id), eq(obligations.ownerId, user.profileId)),
        )
        .for('update');
      if (!current) throw new NotFoundException(OBLIGATION_NOT_FOUND);
      if (current.status === 'archived') {
        throw new ConflictException(
          'La obligación está archivada y no admite cambios',
        );
      }

      const patch = {
        propertyId: dto.propertyId,
        providerName: dto.providerName,
        concept: dto.concept,
        category: dto.category,
        expectedAmount: dto.expectedAmount,
        frequency: dto.frequency,
        dueDay: dto.dueDay,
        reminderDaysBefore: dto.reminderDaysBefore,
        startsOn: dto.startsOn,
        status: dto.status,
        autoGenerate: dto.autoGenerate,
      };
      const { changes, values } = diffPatch(current, patch);
      if (changes.length === 0) return current;
      if (values.propertyId) {
        await assertAssignableProperty(tx, user, values.propertyId);
      }

      // Solo se actualiza la definición: los períodos conservan sus valores.
      const [row] = await tx
        .update(obligations)
        .set(values)
        .where(
          and(eq(obligations.id, id), eq(obligations.ownerId, user.profileId)),
        )
        .returning(obligationColumns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'obligation.update',
        resource: 'obligation',
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
