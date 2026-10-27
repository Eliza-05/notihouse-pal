import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { findDatabaseError } from '../common/database-exception.filter.js';
import { offsetOf, type Page } from '../common/pagination.js';
import { CONTRACT_NOT_FOUND } from '../contracts/contracts.service.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import {
  caseProposals,
  cases,
  contracts,
  obligations,
  rentals,
  workflowJobs,
} from '../database/schema/index.js';
import { WorkflowJobsService } from '../integrations/workflow-jobs.service.js';
import { OBLIGATION_NOT_FOUND } from '../obligations/obligations.service.js';
import { RENTAL_NOT_FOUND } from '../rentals/rentals.service.js';
import { caseColumns, type CaseRow } from './case-lifecycle.js';
import {
  CASE_SUBJECT_FIELD,
  type CaseResponseDto,
  type CreateCaseDto,
  type ListCasesQueryDto,
} from './dto/case.dto.js';
import type {
  ListProposalsQueryDto,
  ProposalResponseDto,
} from './dto/process.dto.js';

const COMPONENT = 'api.cases';
export const CASE_NOT_FOUND = 'Caso no encontrado';

export const proposalColumns = {
  id: caseProposals.id,
  caseId: caseProposals.caseId,
  version: caseProposals.version,
  source: caseProposals.source,
  proposedData: caseProposals.proposedData,
  evidence: caseProposals.evidence,
  confidence: caseProposals.confidence,
  documentId: caseProposals.documentId,
  reviewStatus: caseProposals.reviewStatus,
  reviewedAt: caseProposals.reviewedAt,
  reviewedBy: caseProposals.reviewedBy,
  createdAt: caseProposals.createdAt,
  updatedAt: caseProposals.updatedAt,
};

const SUBJECT_FIELDS = ['obligationId', 'rentalId', 'contractId'] as const;

/** Respuesta sin `ownerId`: el propietario nunca se expone ni se acepta. */
export function toCaseResponse(row: CaseRow): CaseResponseDto {
  const { ownerId: _ownerId, ...rest } = row;
  return rest;
}

/**
 * Casos del usuario autenticado. Crear un caso registra en la misma
 * transacción su trabajo inicial para n8n y la auditoría de ambos.
 */
@Injectable()
export class CasesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly jobs: WorkflowJobsService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListCasesQueryDto,
  ): Promise<Page<CaseResponseDto>> {
    const filters: SQL[] = [eq(cases.ownerId, user.profileId)];
    if (query.status) filters.push(eq(cases.status, query.status));
    if (query.type) filters.push(eq(cases.type, query.type));
    const where = and(...filters);

    const [items, [total]] = await Promise.all([
      this.db
        .select(caseColumns)
        .from(cases)
        .where(where)
        .orderBy(desc(cases.createdAt), desc(cases.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(cases).where(where),
    ]);
    return {
      items: items.map(toCaseResponse),
      page: query.page,
      pageSize: query.pageSize,
      total: total!.n,
    };
  }

  async findOne(user: AuthenticatedUser, id: string): Promise<CaseResponseDto> {
    return toCaseResponse(await this.findOwned(this.db, user, id));
  }

  /**
   * Crea el caso (`received`, origen `form`) y su trabajo inicial. Con
   * `requestId`, una repetición devuelve el caso ya creado (`created: false`);
   * la unicidad la garantiza la clave de idempotencia del trabajo.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateCaseDto,
  ): Promise<{ created: boolean; case: CaseResponseDto }> {
    const subject = this.assertSubjectMatchesType(dto);
    const idempotencyKey = dto.requestId
      ? `case-request:${user.profileId}:${dto.requestId}`
      : null;
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(user, idempotencyKey);
      if (existing)
        return { created: false, case: this.assertSame(existing, dto) };
    }

    try {
      const row = await this.db.transaction(async (tx) => {
        if (subject) await this.assertOwnedSubject(tx, user, subject);
        const correlationId = randomUUID();
        const [created] = await tx
          .insert(cases)
          .values({
            correlationId,
            ownerId: user.profileId,
            type: dto.type,
            source: 'form',
            status: 'received',
            obligationId: dto.obligationId ?? null,
            rentalId: dto.rentalId ?? null,
            contractId: dto.contractId ?? null,
          })
          .returning(caseColumns);
        const actor = { kind: 'user', profileId: user.profileId } as const;
        await this.audit.recordUserAction(tx, {
          profileId: user.profileId,
          correlationId,
          component: COMPONENT,
          action: 'case.create',
          resource: 'case',
          resourceId: created!.id,
          details: {
            type: created!.type,
            source: created!.source,
            ...(subject ? { [subject.field]: subject.id } : {}),
          },
        });
        await this.jobs.enqueue(tx, actor, {
          caseId: created!.id,
          ownerId: user.profileId,
          correlationId,
          jobType: `case.${created!.type}`,
          idempotencyKey: idempotencyKey ?? `case-intake:${created!.id}`,
          payload: {
            caseType: created!.type,
            source: created!.source,
            ...(subject ? { [subject.field]: subject.id } : {}),
          },
        });
        return created!;
      });
      return { created: true, case: toCaseResponse(row) };
    } catch (error) {
      // Dos solicitudes simultáneas con el mismo requestId: la segunda
      // revierte por la clave única y devuelve el caso de la primera.
      if (
        idempotencyKey &&
        findDatabaseError(error)?.constraint ===
          'workflow_jobs_idempotency_key_unique'
      ) {
        const existing = await this.findByIdempotencyKey(user, idempotencyKey);
        if (existing) {
          return { created: false, case: this.assertSame(existing, dto) };
        }
      }
      throw error;
    }
  }

  async listProposals(
    user: AuthenticatedUser,
    caseId: string,
    query: ListProposalsQueryDto,
  ): Promise<Page<ProposalResponseDto>> {
    await this.findOwned(this.db, user, caseId);
    const filters: SQL[] = [
      eq(caseProposals.caseId, caseId),
      eq(caseProposals.ownerId, user.profileId),
    ];
    if (query.reviewStatus) {
      filters.push(eq(caseProposals.reviewStatus, query.reviewStatus));
    }
    const where = and(...filters);
    const [items, [total]] = await Promise.all([
      this.db
        .select(proposalColumns)
        .from(caseProposals)
        .where(where)
        .orderBy(asc(caseProposals.version))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(caseProposals).where(where),
    ]);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: total!.n,
    };
  }

  private async findOwned(
    executor: Database | DbTransaction,
    user: AuthenticatedUser,
    id: string,
  ): Promise<CaseRow> {
    const [row] = await executor
      .select(caseColumns)
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.ownerId, user.profileId)));
    if (!row) throw new NotFoundException(CASE_NOT_FOUND);
    return row;
  }

  private async findByIdempotencyKey(
    user: AuthenticatedUser,
    key: string,
  ): Promise<CaseRow | null> {
    const [row] = await this.db
      .select(caseColumns)
      .from(workflowJobs)
      .innerJoin(cases, eq(cases.id, workflowJobs.caseId))
      .where(
        and(
          eq(workflowJobs.idempotencyKey, key),
          eq(cases.ownerId, user.profileId),
        ),
      );
    return row ?? null;
  }

  /** Reutilizar un `requestId` con otros datos es un error del cliente. */
  private assertSame(existing: CaseRow, dto: CreateCaseDto): CaseResponseDto {
    const same =
      existing.type === dto.type &&
      SUBJECT_FIELDS.every((f) => existing[f] === (dto[f] ?? null));
    if (!same) {
      throw new ConflictException(
        'requestId ya se usó para un caso con otros datos',
      );
    }
    return toCaseResponse(existing);
  }

  /** Como máximo una entidad, y la que corresponde al tipo de caso. */
  private assertSubjectMatchesType(
    dto: CreateCaseDto,
  ): { field: (typeof SUBJECT_FIELDS)[number]; id: string } | null {
    const given = SUBJECT_FIELDS.filter((f) => dto[f] !== undefined);
    if (given.length === 0) return null;
    const expected = CASE_SUBJECT_FIELD[dto.type];
    if (given.length > 1 || given[0] !== expected) {
      throw new BadRequestException(
        `Un caso ${dto.type} solo puede referirse a ${expected}`,
      );
    }
    return { field: expected, id: dto[expected]! };
  }

  /** La entidad referida debe ser del usuario; una ajena responde 404. */
  private async assertOwnedSubject(
    tx: DbTransaction,
    user: AuthenticatedUser,
    subject: { field: (typeof SUBJECT_FIELDS)[number]; id: string },
  ): Promise<void> {
    const table = {
      obligationId: [obligations, OBLIGATION_NOT_FOUND],
      rentalId: [rentals, RENTAL_NOT_FOUND],
      contractId: [contracts, CONTRACT_NOT_FOUND],
    } as const;
    const [entity, message] = table[subject.field];
    const [row] = await tx
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.id, subject.id), eq(entity.ownerId, user.profileId)))
      .for('share');
    if (!row) throw new NotFoundException(message);
  }
}
