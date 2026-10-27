import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, gte, lte, type SQL } from 'drizzle-orm';
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
import { contracts, documents, rentals } from '../database/schema/index.js';
import { assertAssignableProperty } from '../properties/properties.service.js';
import { RENTAL_NOT_FOUND } from '../rentals/rentals.service.js';
import type {
  ContractResponseDto,
  CreateContractDto,
  ListContractsQueryDto,
  UpdateContractDto,
} from './dto/contract.dto.js';

const COMPONENT = 'api.contracts';
export const CONTRACT_NOT_FOUND = 'Contrato no encontrado';
const DOCUMENT_NOT_FOUND = 'Documento no encontrado';

const columns = {
  id: contracts.id,
  propertyId: contracts.propertyId,
  rentalId: contracts.rentalId,
  startsOn: contracts.startsOn,
  endsOn: contracts.endsOn,
  noticePeriodDays: contracts.noticePeriodDays,
  status: contracts.status,
  documentId: contracts.documentId,
  createdAt: contracts.createdAt,
  updatedAt: contracts.updatedAt,
};

/** Campos de fecha cuyo valor anterior y nuevo se registran en la auditoría. */
const DATE_FIELDS = ['startsOn', 'endsOn'] as const;

/**
 * Metadatos de contratos. Toda consulta filtra por el propietario
 * autenticado. No hay renovación, extensión ni vencimiento automático: los
 * estados solo cambian por una edición explícita del propietario.
 */
@Injectable()
export class ContractsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListContractsQueryDto,
  ): Promise<Page<ContractResponseDto>> {
    const filters: SQL[] = [eq(contracts.ownerId, user.profileId)];
    if (query.propertyId)
      filters.push(eq(contracts.propertyId, query.propertyId));
    if (query.rentalId) filters.push(eq(contracts.rentalId, query.rentalId));
    if (query.status) filters.push(eq(contracts.status, query.status));
    if (query.endsFrom) filters.push(gte(contracts.endsOn, query.endsFrom));
    if (query.endsTo) filters.push(lte(contracts.endsOn, query.endsTo));
    const where = and(...filters);

    const [items, [total]] = await Promise.all([
      this.db
        .select(columns)
        .from(contracts)
        .where(where)
        .orderBy(asc(contracts.endsOn), asc(contracts.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(contracts).where(where),
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
  ): Promise<ContractResponseDto> {
    const [row] = await this.db
      .select(columns)
      .from(contracts)
      .where(and(eq(contracts.id, id), eq(contracts.ownerId, user.profileId)));
    if (!row) throw new NotFoundException(CONTRACT_NOT_FOUND);
    return row;
  }

  async create(
    user: AuthenticatedUser,
    correlationId: string,
    dto: CreateContractDto,
  ): Promise<ContractResponseDto> {
    assertDateOrder(dto.startsOn, dto.endsOn, 'startsOn', 'endsOn');
    return this.db.transaction(async (tx) => {
      await assertAssignableProperty(tx, user, dto.propertyId);
      if (dto.rentalId) {
        await this.assertRentalOfProperty(
          tx,
          user,
          dto.rentalId,
          dto.propertyId,
        );
      }
      if (dto.documentId) {
        await this.assertContractDocument(tx, user, dto.documentId);
      }

      const [row] = await tx
        .insert(contracts)
        .values({
          ownerId: user.profileId,
          propertyId: dto.propertyId,
          rentalId: dto.rentalId ?? null,
          startsOn: dto.startsOn,
          endsOn: dto.endsOn,
          noticePeriodDays: dto.noticePeriodDays ?? null,
          documentId: dto.documentId ?? null,
          status: 'active',
        })
        .returning(columns);
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'contract.create',
        resource: 'contract',
        resourceId: row!.id,
        details: {
          propertyId: row!.propertyId,
          rentalId: row!.rentalId,
          endsOn: row!.endsOn,
        },
      });
      return row!;
    });
  }

  async update(
    user: AuthenticatedUser,
    correlationId: string,
    id: string,
    dto: UpdateContractDto,
  ): Promise<ContractResponseDto> {
    assertHasChanges(dto);
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select(columns)
        .from(contracts)
        .where(and(eq(contracts.id, id), eq(contracts.ownerId, user.profileId)))
        .for('update');
      if (!current) throw new NotFoundException(CONTRACT_NOT_FOUND);
      if (current.status !== 'active') {
        throw new ConflictException(
          `El contrato está en estado "${current.status}" y no admite cambios`,
        );
      }

      const patch = {
        startsOn: dto.startsOn,
        endsOn: dto.endsOn,
        noticePeriodDays: dto.noticePeriodDays,
        documentId: dto.documentId,
        status: dto.status,
      };
      assertDateOrder(
        patch.startsOn ?? current.startsOn,
        patch.endsOn ?? current.endsOn,
        'startsOn',
        'endsOn',
      );
      const { changes, values } = diffPatch(current, patch);
      if (changes.length === 0) return current;
      if (values.documentId) {
        await this.assertContractDocument(tx, user, values.documentId);
      }

      const [row] = await tx
        .update(contracts)
        .set(values)
        .where(and(eq(contracts.id, id), eq(contracts.ownerId, user.profileId)))
        .returning(columns);
      // Las fechas contractuales no son sensibles: se audita el valor anterior
      // y el nuevo para que toda corrección manual sea trazable.
      const dateChanges = Object.fromEntries(
        DATE_FIELDS.filter((field) => changes.includes(field)).map((field) => [
          field,
          { from: current[field], to: row![field] },
        ]),
      );
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'contract.update',
        resource: 'contract',
        resourceId: id,
        details: {
          changes,
          ...(Object.keys(dateChanges).length > 0 ? { dateChanges } : {}),
          ...(changes.includes('status')
            ? { statusFrom: current.status, statusTo: row!.status }
            : {}),
        },
      });
      return row!;
    });
  }

  /** El arriendo debe ser propio (404 si no) y del mismo inmueble (400 si no). */
  private async assertRentalOfProperty(
    tx: DbTransaction,
    user: AuthenticatedUser,
    rentalId: string,
    propertyId: string,
  ): Promise<void> {
    const [rental] = await tx
      .select({ propertyId: rentals.propertyId })
      .from(rentals)
      .where(and(eq(rentals.id, rentalId), eq(rentals.ownerId, user.profileId)))
      .for('share');
    if (!rental) throw new NotFoundException(RENTAL_NOT_FOUND);
    if (rental.propertyId !== propertyId) {
      throw new BadRequestException(
        'El arriendo indicado no corresponde al inmueble del contrato',
      );
    }
  }

  /** Solo se vinculan documentos propios ya registrados y de tipo `contract`. */
  private async assertContractDocument(
    tx: DbTransaction,
    user: AuthenticatedUser,
    documentId: string,
  ): Promise<void> {
    const [document] = await tx
      .select({ type: documents.type })
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.ownerId, user.profileId),
        ),
      )
      .for('share');
    if (!document) throw new NotFoundException(DOCUMENT_NOT_FOUND);
    if (document.type !== 'contract') {
      throw new BadRequestException('El documento no es de tipo contrato');
    }
  }
}
