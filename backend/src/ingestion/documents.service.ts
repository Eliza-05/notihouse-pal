import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { recordProcessEvent } from '../audit/process-actor.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { offsetOf, type Page } from '../common/pagination.js';
import { DRIZZLE, type Database } from '../database/database.constants.js';
import { cases, documents } from '../database/schema/index.js';
import { WorkflowJobsService } from '../integrations/workflow-jobs.service.js';
import {
  FILE_STORAGE,
  type FileStorage,
  StorageObjectNotFoundError,
  type StoredObject,
} from '../storage/file-storage.js';
import {
  type DocumentResponseDto,
  INGESTION_JOB_TYPES,
  type ListDocumentsQueryDto,
} from './dto/ingestion.dto.js';

export const DOCUMENT_NOT_FOUND = 'Documento no encontrado';

/** Columnas expuestas: nunca la clave de almacenamiento. */
const publicColumns = {
  id: documents.id,
  caseId: documents.caseId,
  type: documents.type,
  source: documents.source,
  mimeType: documents.mimeType,
  fileName: documents.fileName,
  sha256: documents.sha256,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

/** Qué tipo de trabajo puede leer cada tipo de documento. */
const READABLE_BY_JOB: Record<string, readonly string[]> = {
  invoice: [INGESTION_JOB_TYPES.document],
  payment_receipt: [INGESTION_JOB_TYPES.document],
  contract: [INGESTION_JOB_TYPES.document],
  voice_note: [INGESTION_JOB_TYPES.voice],
};

export interface DocumentContent {
  document: DocumentResponseDto;
  object: StoredObject;
}

/**
 * Documentos privados. El usuario solo ve los suyos; el worker solo lee el
 * archivo del caso cuyo trabajo tiene reclamado, y solo si el tipo de
 * trabajo corresponde al tipo de documento. No hay borrado ni reasignación.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly jobs: WorkflowJobsService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListDocumentsQueryDto,
  ): Promise<Page<DocumentResponseDto>> {
    const filters: SQL[] = [eq(documents.ownerId, user.profileId)];
    if (query.type) filters.push(eq(documents.type, query.type));
    if (query.source) filters.push(eq(documents.source, query.source));
    if (query.caseId) filters.push(eq(documents.caseId, query.caseId));
    const where = and(...filters);
    const [items, [total]] = await Promise.all([
      this.db
        .select(publicColumns)
        .from(documents)
        .where(where)
        .orderBy(desc(documents.createdAt), desc(documents.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(documents).where(where),
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
  ): Promise<DocumentResponseDto> {
    const [row] = await this.db
      .select(publicColumns)
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, user.profileId)));
    if (!row) throw new NotFoundException(DOCUMENT_NOT_FOUND);
    return row;
  }

  async openForUser(
    user: AuthenticatedUser,
    id: string,
  ): Promise<DocumentContent> {
    const [row] = await this.db
      .select({ ...publicColumns, storageKey: documents.storageKey })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, user.profileId)));
    if (!row) throw new NotFoundException(DOCUMENT_NOT_FOUND);
    const { storageKey, ...document } = row;
    return { document, object: await this.open(storageKey) };
  }

  /**
   * Lectura para el worker. Exige, dentro de una transacción: documento con
   * caso; reclamación vigente de un trabajo de ESE caso (token de reclamación
   * válido, arrendamiento activo); mismo propietario; y un tipo de trabajo
   * autorizado para el tipo de documento. Conocer el id no basta.
   */
  async openForWorker(
    id: string,
    jobId: string,
    claimToken: string,
  ): Promise<DocumentContent> {
    const row = await this.db.transaction(async (tx) => {
      const [doc] = await tx
        .select({
          ...publicColumns,
          ownerId: documents.ownerId,
          storageKey: documents.storageKey,
          caseOwnerId: cases.ownerId,
        })
        .from(documents)
        .leftJoin(cases, eq(cases.id, documents.caseId))
        .where(eq(documents.id, id));
      if (!doc || !doc.caseId) throw new NotFoundException(DOCUMENT_NOT_FOUND);
      const claim = await this.jobs.verifyActiveClaim(
        tx,
        jobId,
        claimToken,
        doc.caseId,
      );
      if (claim.ownerId !== doc.ownerId || doc.caseOwnerId !== doc.ownerId) {
        throw new NotFoundException(DOCUMENT_NOT_FOUND);
      }
      if (!(READABLE_BY_JOB[doc.type] ?? []).includes(claim.jobType)) {
        throw new ForbiddenException(
          'El tipo de trabajo reclamado no está autorizado para leer este documento',
        );
      }
      await recordProcessEvent(
        this.audit,
        tx,
        { kind: 'workflow', workerId: claim.workerId },
        {
          ownerId: doc.ownerId,
          correlationId: claim.correlationId,
          component: 'api.internal.documents',
          action: 'document.content_access',
          resource: 'document',
          resourceId: id,
          details: { caseId: doc.caseId, jobId, jobType: claim.jobType },
        },
      );
      return doc;
    });
    const { storageKey, ownerId: _o, caseOwnerId: _c, ...document } = row;
    return { document, object: await this.open(storageKey) };
  }

  private async open(storageKey: string): Promise<StoredObject> {
    try {
      return await this.storage.get(storageKey);
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        // El registro existe pero el objeto no: no se revela el detalle.
        throw new NotFoundException(
          'El contenido del documento no está disponible',
        );
      }
      throw new ServiceUnavailableException(
        'El almacenamiento de archivos no está disponible',
      );
    }
  }
}
