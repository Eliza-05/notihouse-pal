import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import type { CaseRow } from '../cases/case-lifecycle.js';
import { type CaseSubject, CasesService } from '../cases/cases.service.js';
import type { CaseType } from '../cases/dto/case.dto.js';
import { findDatabaseError } from '../common/database-exception.filter.js';
import { DRIZZLE, type Database } from '../database/database.constants.js';
import { cases, documents, workflowJobs } from '../database/schema/index.js';
import { WorkflowJobsService } from '../integrations/workflow-jobs.service.js';
import {
  FILE_STORAGE,
  type FileStorage,
  newStorageKey,
} from '../storage/file-storage.js';
import {
  CASE_TYPE_FOR_DOCUMENT,
  INGESTION_JOB_TYPES,
  type IngestionResponseDto,
  type UploadDocumentDto,
  type UploadVoiceDto,
} from './dto/ingestion.dto.js';
import { verifyAudioStructure } from './audio-structure.js';
import {
  acceptUpload,
  type ReceivedFile,
  type UploadKind,
} from './file-policy.js';

const COMPONENT = 'api.ingestion';

type DocumentType = (typeof documents.$inferInsert)['type'];

interface IngestionSpec {
  kind: UploadKind;
  source: 'document' | 'voice';
  documentType: DocumentType;
  caseType: CaseType;
  refs: Partial<Record<'obligationId' | 'rentalId' | 'contractId', string>>;
  requestId?: string;
}

/** Lo que identifica una carga a efectos de idempotencia. */
interface IngestionFingerprint {
  sha256: string;
  documentType: DocumentType;
  caseType: CaseType;
  subject: CaseSubject | null;
}

/**
 * Ingesta de facturas PDF y notas de voz.
 *
 * Orden: validar archivo y referencias → (idempotencia) → guardar el objeto
 * privado → en UNA transacción de PostgreSQL: caso + documento + trabajo +
 * auditoría. El almacenamiento y PostgreSQL no comparten transacción: si la
 * transacción falla, se elimina el objeto recién creado (compensación); si
 * la compensación falla, queda auditado como huérfano.
 *
 * Recibir un archivo NO lo procesa: no hay OCR, IA ni transcripción aquí.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly cases: CasesService,
    private readonly jobs: WorkflowJobsService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  ingestDocument(
    user: AuthenticatedUser,
    file: ReceivedFile | undefined,
    dto: UploadDocumentDto,
  ) {
    const documentType = dto.documentType ?? 'invoice';
    return this.ingest(user, file, {
      kind: 'pdf',
      source: 'document',
      documentType,
      caseType: CASE_TYPE_FOR_DOCUMENT[documentType],
      refs: { obligationId: dto.obligationId, contractId: dto.contractId },
      requestId: dto.requestId,
    });
  }

  ingestVoice(
    user: AuthenticatedUser,
    file: ReceivedFile | undefined,
    dto: UploadVoiceDto,
  ) {
    return this.ingest(user, file, {
      kind: 'audio',
      source: 'voice',
      documentType: 'voice_note',
      caseType: dto.caseType ?? 'household_obligation',
      refs: {
        obligationId: dto.obligationId,
        rentalId: dto.rentalId,
        contractId: dto.contractId,
      },
      requestId: dto.requestId,
    });
  }

  private async ingest(
    user: AuthenticatedUser,
    file: ReceivedFile | undefined,
    spec: IngestionSpec,
  ): Promise<{ created: boolean; result: IngestionResponseDto }> {
    if (!file) {
      throw new BadRequestException(
        'Adjunta el archivo en el campo "file" (multipart/form-data)',
      );
    }
    const subject = this.cases.assertSubjectMatchesType(
      spec.caseType,
      spec.refs,
    );
    const accepted = acceptUpload(spec.kind, file);
    if (accepted.format !== 'pdf') {
      // Estructura interna: todas las pistas deben ser de audio admitido.
      await verifyAudioStructure(accepted.format, file.path, file.size);
    }
    // Referencias ajenas se rechazan antes de escribir nada en el almacenamiento.
    if (subject) await this.cases.assertOwnedSubject(this.db, user, subject);

    const fingerprint: IngestionFingerprint = {
      sha256: file.sha256,
      documentType: spec.documentType,
      caseType: spec.caseType,
      subject,
    };
    const idempotencyKey = spec.requestId
      ? `ingest:${spec.source}:${user.profileId}:${spec.requestId}`
      : null;
    if (idempotencyKey) {
      const existing = await this.findIngestion(user, idempotencyKey);
      if (existing) {
        return { created: false, result: assertSame(existing, fingerprint) };
      }
    }

    const storageKey = newStorageKey(
      spec.source === 'voice' ? 'voice' : 'documents',
    );
    // Se abre ya (no de forma diferida): el temporal se elimina al terminar la solicitud.
    const source = (await open(file.path, 'r')).createReadStream();
    try {
      await this.storage.put(storageKey, source, {
        contentType: accepted.mimeType,
        size: file.size,
      });
    } catch (error) {
      this.logger.warn(
        `Fallo del almacenamiento: ${(error as Error).constructor.name}`,
      );
      await this.recordFailure(user, 'document.store_failed', storageKey, {
        source: spec.source,
        documentType: spec.documentType,
        sizeBytes: file.size,
        sha256: file.sha256,
      });
      throw new ServiceUnavailableException(
        'No fue posible almacenar el archivo. Intenta más tarde.',
      );
    } finally {
      // Si el proveedor falló sin consumirlo, el stream no debe quedar abierto
      // (ni intentar abrir el temporal después de eliminarlo).
      source.destroy();
    }

    try {
      const result = await this.db.transaction(async (tx) => {
        if (subject) await this.cases.assertOwnedSubject(tx, user, subject);
        const [previous] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.ownerId, user.profileId),
              eq(documents.sha256, file.sha256),
              ne(documents.storageKey, storageKey),
            ),
          )
          .limit(1);
        const caseRow = await this.cases.insertCase(tx, user, {
          type: spec.caseType,
          source: spec.source,
          subject,
        });
        const [document] = await tx
          .insert(documents)
          .values({
            ownerId: user.profileId,
            caseId: caseRow.id,
            type: spec.documentType,
            source: spec.source,
            mimeType: accepted.mimeType,
            fileName: accepted.fileName,
            storageKey,
            sha256: file.sha256,
          })
          .returning({ id: documents.id });
        await this.audit.recordUserAction(tx, {
          profileId: user.profileId,
          correlationId: caseRow.correlationId,
          component: COMPONENT,
          action:
            spec.source === 'voice' ? 'voice_note.receive' : 'document.receive',
          resource: 'document',
          resourceId: document!.id,
          details: {
            caseId: caseRow.id,
            documentType: spec.documentType,
            mimeType: accepted.mimeType,
            sizeBytes: file.size,
            sha256: file.sha256,
            duplicateContent: previous !== undefined,
          },
        });
        const jobType = INGESTION_JOB_TYPES[spec.source];
        await this.jobs.enqueue(
          tx,
          { kind: 'user', profileId: user.profileId },
          {
            caseId: caseRow.id,
            ownerId: user.profileId,
            correlationId: caseRow.correlationId,
            jobType,
            idempotencyKey:
              idempotencyKey ?? `${spec.source}-intake:${document!.id}`,
            payload: {
              documentId: document!.id,
              documentType: spec.documentType,
              mimeType: accepted.mimeType,
              sizeBytes: file.size,
              caseType: spec.caseType,
              ...(subject ? { [subject.field]: subject.id } : {}),
            },
          },
        );
        return toResponse(
          caseRow,
          {
            id: document!.id,
            type: spec.documentType,
            mimeType: accepted.mimeType,
            sha256: file.sha256,
          },
          { type: jobType, status: 'pending', sizeBytes: file.size },
          previous !== undefined,
        );
      });
      return { created: true, result };
    } catch (error) {
      // PostgreSQL no confirmó: el objeto recién creado no debe quedar suelto.
      await this.compensate(user, storageKey);
      if (
        idempotencyKey &&
        findDatabaseError(error)?.constraint ===
          'workflow_jobs_idempotency_key_unique'
      ) {
        // Otra solicitud con la misma clave ganó la carrera.
        const existing = await this.findIngestion(user, idempotencyKey);
        if (existing) {
          return { created: false, result: assertSame(existing, fingerprint) };
        }
      }
      throw error;
    }
  }

  /** Caso, documento y trabajo de una ingesta previa con la misma clave. */
  private async findIngestion(user: AuthenticatedUser, key: string) {
    const [job] = await this.db
      .select({
        caseId: workflowJobs.caseId,
        jobType: workflowJobs.jobType,
        status: workflowJobs.status,
        payload: workflowJobs.payload,
      })
      .from(workflowJobs)
      .innerJoin(cases, eq(cases.id, workflowJobs.caseId))
      .where(
        and(
          eq(workflowJobs.idempotencyKey, key),
          eq(cases.ownerId, user.profileId),
        ),
      );
    if (!job) return null;
    const caseRow = await this.cases.findByIdempotencyKey(user, key);
    const [document] = await this.db
      .select({
        id: documents.id,
        type: documents.type,
        mimeType: documents.mimeType,
        sha256: documents.sha256,
      })
      .from(documents)
      .where(
        and(
          eq(documents.caseId, job.caseId),
          eq(documents.ownerId, user.profileId),
        ),
      );
    if (!caseRow || !document) return null;
    const payload = job.payload as { sizeBytes?: number };
    return {
      caseRow,
      document,
      job: {
        type: job.jobType,
        status: job.status,
        sizeBytes: payload.sizeBytes ?? 0,
      },
    };
  }

  private async compensate(
    user: AuthenticatedUser,
    storageKey: string,
  ): Promise<void> {
    try {
      await this.storage.removeAfterFailedWrite(storageKey);
    } catch {
      this.logger.error(
        'No se pudo retirar un objeto tras un fallo de PostgreSQL; queda registrado como huérfano',
      );
      await this.recordFailure(user, 'document.orphaned', storageKey, {});
    }
  }

  /**
   * Evento de fallo en su propia transacción (la de negocio no existió o se
   * revirtió). Incluye la clave interna del objeto para poder limpiarlo; no
   * es un secreto ni una URL. Si tampoco se puede auditar, solo se registra
   * en el log, sin datos sensibles.
   */
  private async recordFailure(
    user: AuthenticatedUser,
    action: string,
    storageKey: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.transaction((tx) =>
        this.audit.recordUserAction(tx, {
          profileId: user.profileId,
          correlationId: randomUUID(),
          component: COMPONENT,
          action,
          resource: 'storage_object',
          resourceId: storageKey,
          result: 'failure',
          details,
        }),
      );
    } catch {
      this.logger.error(`No se pudo auditar el evento ${action}`);
    }
  }
}

type ExistingIngestion = NonNullable<
  Awaited<ReturnType<IngestionService['findIngestion']>>
>;

/** Reutilizar `requestId` con otro archivo o con otros datos es un conflicto. */
function assertSame(
  existing: ExistingIngestion,
  expected: IngestionFingerprint,
): IngestionResponseDto {
  const { caseRow, document } = existing;
  const subjectMatches = (
    ['obligationId', 'rentalId', 'contractId'] as const
  ).every(
    (field) =>
      caseRow[field] ===
      (expected.subject?.field === field ? expected.subject.id : null),
  );
  if (
    document.sha256 !== expected.sha256 ||
    document.type !== expected.documentType ||
    caseRow.type !== expected.caseType ||
    !subjectMatches
  ) {
    throw new ConflictException(
      'requestId ya se usó con otro archivo o con otros datos',
    );
  }
  return toResponse(caseRow, document, existing.job, false);
}

function toResponse(
  caseRow: CaseRow,
  document: {
    id: string;
    type: string;
    mimeType: string;
    sha256: string | null;
  },
  job: { type: string; status: string; sizeBytes: number },
  duplicateContent: boolean,
): IngestionResponseDto {
  return {
    documentId: document.id,
    caseId: caseRow.id,
    correlationId: caseRow.correlationId,
    caseStatus: caseRow.status,
    source: caseRow.source,
    documentType: document.type,
    mimeType: document.mimeType,
    sha256: document.sha256 ?? '',
    sizeBytes: job.sizeBytes,
    job: { type: job.type, status: job.status },
    processing: 'pending',
    duplicateContent,
  };
}
