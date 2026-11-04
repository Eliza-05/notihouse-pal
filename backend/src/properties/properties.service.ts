import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { assertHasChanges, diffPatch } from '../common/dto-helpers.js';
import { offsetOf, type Page } from '../common/pagination.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import { properties } from '../database/schema/index.js';
import type {
  CreatePropertyDto,
  ListPropertiesQueryDto,
  PropertyResponseDto,
  UpdatePropertyDto,
} from './dto/property.dto.js';

const COMPONENT = 'api.properties';
export const PROPERTY_NOT_FOUND = 'Inmueble no encontrado';

/**
 * El inmueble debe existir, ser del mismo propietario y estar activo para
 * asociarle obligaciones, arriendos o contratos. Uno ajeno se trata como
 * inexistente (no se revela su existencia). `FOR SHARE` impide que se
 * desactive mientras dura la transacción que lo asocia.
 */
export async function assertAssignableProperty(
  tx: DbTransaction,
  user: AuthenticatedUser,
  propertyId: string,
  lock: 'share' | 'no key update' = 'share',
): Promise<void> {
  const [property] = await tx
    .select({ status: properties.status })
    .from(properties)
    .where(
      and(
        eq(properties.id, propertyId),
        eq(properties.ownerId, user.profileId),
      ),
    )
    .for(lock);
  if (!property) throw new NotFoundException(PROPERTY_NOT_FOUND);
  if (property.status !== 'active') {
    throw new ConflictException('El inmueble no está activo');
  }
}

const columns = {
  id: properties.id,
  name: properties.name,
  address: properties.address,
  description: properties.description,
  status: properties.status,
  createdAt: properties.createdAt,
  updatedAt: properties.updatedAt,
};

/**
 * Toda consulta filtra por `owner_id = user.profileId`: un inmueble de otro
 * propietario es indistinguible de uno inexistente (404).
 */
@Injectable()
export class PropertiesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListPropertiesQueryDto,
  ): Promise<Page<PropertyResponseDto>> {
    const filters: SQL[] = [eq(properties.ownerId, user.profileId)];
    if (query.status) filters.push(eq(properties.status, query.status));
    const where = and(...filters);

    const [items, [total]] = await Promise.all([
      this.db
        .select(columns)
        .from(properties)
        .where(where)
        .orderBy(asc(properties.createdAt), asc(properties.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(properties).where(where),
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
  ): Promise<PropertyResponseDto> {
    const [row] = await this.db
      .select(columns)
      .from(properties)
      .where(
        and(eq(properties.id, id), eq(properties.ownerId, user.profileId)),
      );
    if (!row) throw new NotFoundException(PROPERTY_NOT_FOUND);
    return row;
  }

  async create(
    user: AuthenticatedUser,
    correlationId: string,
    dto: CreatePropertyDto,
  ): Promise<PropertyResponseDto> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(properties)
        .values({
          ownerId: user.profileId,
          name: dto.name,
          address: dto.address ?? null,
          description: dto.description ?? null,
        })
        .returning(columns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'property.create',
        resource: 'property',
        resourceId: row!.id,
      });
      return row!;
    });
  }

  async update(
    user: AuthenticatedUser,
    correlationId: string,
    id: string,
    dto: UpdatePropertyDto,
  ): Promise<PropertyResponseDto> {
    assertHasChanges(dto);
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select(columns)
        .from(properties)
        .where(
          and(eq(properties.id, id), eq(properties.ownerId, user.profileId)),
        )
        .for('update');
      if (!current) throw new NotFoundException(PROPERTY_NOT_FOUND);

      const patch = {
        name: dto.name,
        address: dto.address,
        description: dto.description,
        status: dto.status,
      };
      const { changes, values } = diffPatch(current, patch);
      if (changes.length === 0) return current;

      const [row] = await tx
        .update(properties)
        .set(values)
        .where(
          and(eq(properties.id, id), eq(properties.ownerId, user.profileId)),
        )
        .returning(columns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'property.update',
        resource: 'property',
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
