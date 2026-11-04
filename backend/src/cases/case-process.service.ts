import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import {
  type ProcessActor,
  recordProcessEvent,
} from '../audit/process-actor.js';
import { sanitizeErrorMessage } from '../common/sanitize.js';
import { jsonByteLength } from '../common/validators.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import {
  caseProposals,
  documents,
  hitlRequests,
} from '../database/schema/index.js';
import { WorkflowJobsService } from '../integrations/workflow-jobs.service.js';
import {
  type CaseRow,
  hasPendingHitl,
  isTerminalCase,
  lockCase,
  transitionCase,
} from './case-lifecycle.js';
import {
  CASE_NOT_FOUND,
  proposalColumns,
  toCaseResponse,
} from './cases.service.js';
import type { CaseResponseDto } from './dto/case.dto.js';
import type {
  ClaimReferenceDto,
  CreateHitlRequestDto,
  CreateProposalDto,
  FailCaseDto,
  HitlResponseDto,
  ProposalResponseDto,
} from './dto/process.dto.js';
import { hitlColumns } from './hitl.service.js';

const COMPONENT = 'api.internal.cases';

/**
 * Escrituras del servicio de automatización sobre casos. Todas exigen la
 * reclamación vigente de un trabajo del MISMO caso: el propietario sale del
 * caso en PostgreSQL, nunca del cliente. Ninguna toca tablas financieras.
 */
@Injectable()
export class CaseProcessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly jobs: WorkflowJobsService,
  ) {}

  /**
   * Nueva versión de propuesta (`pending_review`). Si coincide exactamente
   * con cualquier versión anterior del caso (reintento, aunque llegue tarde o
   * fuera de orden) se devuelve esa versión sin crear otra ni reactivarla. Las versiones anteriores pendientes pasan a `superseded`
   * y sus revisiones HITL pendientes se anulan.
   */
  async createProposal(
    caseId: string,
    dto: CreateProposalDto,
  ): Promise<{ created: boolean; proposal: ProposalResponseDto }> {
    return this.db.transaction(async (tx) => {
      const { caseRow, actor } = await this.openCase(tx, caseId, dto);
      if (dto.documentId) {
        const [doc] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.id, dto.documentId),
              eq(documents.ownerId, caseRow.ownerId),
            ),
          );
        if (!doc) throw new NotFoundException('Documento no encontrado');
      }

      const [latest] = await tx
        .select({ id: caseProposals.id, version: caseProposals.version })
        .from(caseProposals)
        .where(eq(caseProposals.caseId, caseId))
        .orderBy(desc(caseProposals.version))
        .limit(1);
      if (latest) {
        // Se compara con TODAS las versiones del caso, no solo con la última:
        // un reintento tardío de una versión ya reemplazada devuelve esa
        // versión (con su estado) y nunca la recrea ni reemplaza a la vigente.
        const [same] = await tx
          .select(proposalColumns)
          .from(caseProposals)
          .where(
            and(
              eq(caseProposals.caseId, caseId),
              eq(caseProposals.source, dto.source),
              sql`${caseProposals.proposedData} = ${JSON.stringify(dto.proposedData)}::jsonb`,
              sql`${caseProposals.evidence} IS NOT DISTINCT FROM ${dto.evidence === undefined ? null : JSON.stringify(dto.evidence)}::jsonb`,
              sql`${caseProposals.confidence} IS NOT DISTINCT FROM ${dto.confidence ?? null}::numeric`,
              sql`${caseProposals.documentId} IS NOT DISTINCT FROM ${dto.documentId ?? null}::uuid`,
            ),
          )
          .orderBy(desc(caseProposals.version))
          .limit(1);
        if (same) return { created: false, proposal: same };
      }

      const [proposal] = await tx
        .insert(caseProposals)
        .values({
          caseId,
          ownerId: caseRow.ownerId,
          version: (latest?.version ?? 0) + 1,
          source: dto.source,
          proposedData: dto.proposedData,
          evidence: dto.evidence ?? null,
          confidence: dto.confidence ?? null,
          documentId: dto.documentId ?? null,
          reviewStatus: 'pending_review',
        })
        .returning(proposalColumns);
      const event = {
        ownerId: caseRow.ownerId,
        correlationId: caseRow.correlationId,
        component: COMPONENT,
      };
      await recordProcessEvent(this.audit, tx, actor, {
        ...event,
        action: 'case_proposal.create',
        resource: 'case_proposal',
        resourceId: proposal!.id,
        details: {
          caseId,
          jobId: dto.jobId,
          version: proposal!.version,
          source: dto.source,
          proposedDataBytes: jsonByteLength(dto.proposedData),
          appliedToBusinessData: false,
        },
      });

      const superseded = await tx
        .update(caseProposals)
        .set({ reviewStatus: 'superseded' })
        .where(
          and(
            eq(caseProposals.caseId, caseId),
            eq(caseProposals.reviewStatus, 'pending_review'),
            ne(caseProposals.id, proposal!.id),
          ),
        )
        .returning({ id: caseProposals.id, version: caseProposals.version });
      for (const old of superseded) {
        await recordProcessEvent(this.audit, tx, actor, {
          ...event,
          action: 'case_proposal.supersede',
          resource: 'case_proposal',
          resourceId: old.id,
          details: { caseId, version: old.version, supersededBy: proposal!.id },
        });
      }
      if (superseded.length > 0) {
        const cancelled = await tx
          .update(hitlRequests)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(hitlRequests.status, 'pending'),
              inArray(
                hitlRequests.proposalId,
                superseded.map((p) => p.id),
              ),
            ),
          )
          .returning({ id: hitlRequests.id });
        for (const { id } of cancelled) {
          await recordProcessEvent(this.audit, tx, actor, {
            ...event,
            action: 'hitl_request.cancel',
            resource: 'hitl_request',
            resourceId: id,
            details: { caseId, reason: 'proposal_superseded' },
          });
        }
        if (
          cancelled.length > 0 &&
          caseRow.status === 'awaiting_human' &&
          !(await hasPendingHitl(tx, caseId))
        ) {
          await transitionCase(tx, this.audit, caseRow, 'processing', actor);
        }
      }
      return { created: true, proposal: proposal! };
    });
  }

  /**
   * Solicita una revisión humana. El usuario asignado es siempre el
   * propietario del caso y la fecha límite es `now() + 24 h` (valor por
   * defecto de la columna). Un reintento idéntico devuelve la solicitud ya creada.
   */
  async createHitlRequest(
    caseId: string,
    dto: CreateHitlRequestDto,
  ): Promise<{ created: boolean; request: HitlResponseDto }> {
    const keys = (dto.options.choices ?? []).map((c) => c.key);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException(
        'Las alternativas deben tener claves únicas',
      );
    }
    const options = {
      summary: dto.options.summary,
      ...(dto.options.choices
        ? {
            choices: dto.options.choices.map(({ key, label }) => ({
              key,
              label,
            })),
          }
        : {}),
      ...(dto.options.context ? { context: dto.options.context } : {}),
    };

    return this.db.transaction(async (tx) => {
      const { caseRow, actor } = await this.openCase(tx, caseId, dto);
      if (dto.proposalId) {
        const [proposal] = await tx
          .select({ reviewStatus: caseProposals.reviewStatus })
          .from(caseProposals)
          .where(
            and(
              eq(caseProposals.id, dto.proposalId),
              eq(caseProposals.caseId, caseId),
            ),
          )
          .for('update');
        if (!proposal)
          throw new NotFoundException('Propuesta no encontrada en este caso');
        if (proposal.reviewStatus !== 'pending_review') {
          throw new ConflictException(
            'La propuesta ya no está pendiente de revisión',
          );
        }
      }

      const [duplicate] = await tx
        .select(hitlColumns)
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.caseId, caseId),
            eq(hitlRequests.status, 'pending'),
            eq(hitlRequests.decisionType, dto.decisionType),
            sql`${hitlRequests.proposalId} IS NOT DISTINCT FROM ${dto.proposalId ?? null}::uuid`,
            sql`${hitlRequests.options} = ${JSON.stringify(options)}::jsonb`,
          ),
        );
      if (duplicate) return { created: false, request: duplicate };

      const [request] = await tx
        .insert(hitlRequests)
        .values({
          caseId,
          ownerId: caseRow.ownerId,
          assignedTo: caseRow.ownerId,
          proposalId: dto.proposalId ?? null,
          decisionType: dto.decisionType,
          options,
          status: 'pending',
        })
        .returning(hitlColumns);
      await recordProcessEvent(this.audit, tx, actor, {
        ownerId: caseRow.ownerId,
        correlationId: caseRow.correlationId,
        component: COMPONENT,
        action: 'hitl_request.create',
        resource: 'hitl_request',
        resourceId: request!.id,
        details: {
          caseId,
          jobId: dto.jobId,
          decisionType: dto.decisionType,
          proposalId: dto.proposalId ?? null,
          choices: keys.length,
          dueAt: request!.dueAt.toISOString(),
        },
      });
      if (caseRow.status !== 'awaiting_human') {
        await transitionCase(tx, this.audit, caseRow, 'awaiting_human', actor);
      }
      return { created: true, request: request! };
    });
  }

  /** Cierra el caso como completado: sin revisiones HITL pendientes. Idempotente. */
  async completeCase(
    caseId: string,
    dto: ClaimReferenceDto,
  ): Promise<CaseResponseDto> {
    return this.db.transaction(async (tx) => {
      const { caseRow, actor } = await this.lockedCase(tx, caseId, dto);
      if (caseRow.status === 'completed') return toCaseResponse(caseRow);
      if (isTerminalCase(caseRow.status)) {
        throw new ConflictException(
          `El caso está cerrado como "${caseRow.status}"`,
        );
      }
      if (await hasPendingHitl(tx, caseId)) {
        throw new ConflictException(
          'El caso tiene revisiones humanas pendientes; no puede completarse',
        );
      }
      return toCaseResponse(
        await transitionCase(tx, this.audit, caseRow, 'completed', actor),
      );
    });
  }

  /** Cierra el caso como fallido con un motivo saneado. Idempotente. */
  async failCase(caseId: string, dto: FailCaseDto): Promise<CaseResponseDto> {
    return this.db.transaction(async (tx) => {
      const { caseRow, actor } = await this.lockedCase(tx, caseId, dto);
      if (caseRow.status === 'failed') return toCaseResponse(caseRow);
      if (isTerminalCase(caseRow.status)) {
        throw new ConflictException(
          `El caso está cerrado como "${caseRow.status}"`,
        );
      }
      return toCaseResponse(
        await transitionCase(
          tx,
          this.audit,
          caseRow,
          'failed',
          actor,
          sanitizeErrorMessage(dto.reason),
        ),
      );
    });
  }

  /** Reclamación vigente del trabajo + caso bloqueado (orden trabajo → caso). */
  private async lockedCase(
    tx: DbTransaction,
    caseId: string,
    claim: ClaimReferenceDto,
  ): Promise<{ caseRow: CaseRow; actor: ProcessActor }> {
    const verified = await this.jobs.verifyActiveClaim(
      tx,
      claim.jobId,
      claim.claimToken,
      caseId,
    );
    const caseRow = await lockCase(tx, caseId);
    if (!caseRow) throw new NotFoundException(CASE_NOT_FOUND);
    await this.jobs.assertLeaseStillLive(tx, claim.jobId);
    return {
      caseRow,
      actor: { kind: 'workflow', workerId: verified.workerId },
    };
  }

  /** Como `lockedCase`, pero exige que el caso siga abierto. */
  private async openCase(
    tx: DbTransaction,
    caseId: string,
    claim: ClaimReferenceDto,
  ) {
    const locked = await this.lockedCase(tx, caseId, claim);
    if (isTerminalCase(locked.caseRow.status)) {
      throw new ConflictException(
        `El caso está cerrado como "${locked.caseRow.status}"`,
      );
    }
    return locked;
  }
}
