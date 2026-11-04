import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import {
  type ProcessActor,
  recordProcessEvent,
} from '../audit/process-actor.js';
import {
  isTerminalCase,
  lockCase,
  TERMINAL_CASE_STATUSES,
  transitionCase,
} from '../cases/case-lifecycle.js';
import { sanitizeErrorMessage } from '../common/sanitize.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import { cases, workflowJobs as jobs } from '../database/schema/index.js';
import {
  type ClaimedJobDto,
  type ClaimJobsDto,
  type CompleteJobDto,
  DEFAULT_CLAIM_BATCH,
  DEFAULT_LEASE_SECONDS,
  type FailJobDto,
  type HeartbeatJobDto,
  type WorkflowJobDto,
} from './dto/workflow-job.dto.js';
import {
  claimFingerprint,
  matchClaim,
  newClaimToken,
  retryDelaySeconds,
  workerOf,
} from './job-claims.js';

const COMPONENT = 'api.workflow-jobs';
export const JOB_NOT_FOUND = 'Trabajo no encontrado';
export const INVALID_CLAIM =
  'La reclamación no es válida o fue reemplazada por otra';
export const LEASE_EXPIRED =
  'El arrendamiento del trabajo venció; vuelve a reclamarlo';
export const CONTRADICTORY_RESULT =
  'El trabajo ya se completó con un resultado distinto; no se modificó';

const jobColumns = {
  id: jobs.id,
  caseId: jobs.caseId,
  jobType: jobs.jobType,
  status: jobs.status,
  payload: jobs.payload,
  attempts: jobs.attempts,
  maxAttempts: jobs.maxAttempts,
  availableAt: jobs.availableAt,
  lockedBy: jobs.lockedBy,
  lockedUntil: jobs.lockedUntil,
  result: jobs.result,
  lastError: jobs.lastError,
  completedAt: jobs.completedAt,
  /** Evaluado con el reloj de PostgreSQL, no con el del proceso Node. */
  leaseActive: sql<boolean>`coalesce(${jobs.lockedUntil} > now(), false)`,
};

const caseSummary = {
  caseOwnerId: cases.ownerId,
  caseCorrelationId: cases.correlationId,
  caseType: cases.type,
  caseSource: cases.source,
  caseStatus: cases.status,
  caseObligationId: cases.obligationId,
  caseRentalId: cases.rentalId,
  caseContractId: cases.contractId,
};

type JobRow = NonNullable<
  Awaited<ReturnType<WorkflowJobsService['selectJob']>>
>;

/** Trabajo con su reclamación vigente verificada. */
export interface ActiveClaim {
  jobId: string;
  caseId: string;
  jobType: string;
  workerId: string;
  ownerId: string;
  correlationId: string;
}

export interface EnqueueJob {
  caseId: string;
  ownerId: string;
  correlationId: string;
  jobType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/**
 * Cola persistente consumida por n8n (modelo pull). Completar un trabajo solo
 * registra el fin de la automatización: nunca confirma pagos, cobros ni
 * contratos, ni aprueba propuestas.
 */
@Injectable()
export class WorkflowJobsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registra un trabajo dentro de la transacción de la operación que lo
   * origina (creación del caso, decisión HITL). La clave de idempotencia es
   * única: un duplicado viola `workflow_jobs_idempotency_key_unique`.
   */
  async enqueue(
    tx: DbTransaction,
    actor: ProcessActor,
    job: EnqueueJob,
  ): Promise<{ id: string }> {
    const [row] = await tx
      .insert(jobs)
      .values({
        caseId: job.caseId,
        jobType: job.jobType,
        idempotencyKey: job.idempotencyKey,
        payload: job.payload,
        status: 'pending',
      })
      .returning({ id: jobs.id });
    await recordProcessEvent(this.audit, tx, actor, {
      ownerId: job.ownerId,
      correlationId: job.correlationId,
      component: COMPONENT,
      action: 'workflow_job.create',
      resource: 'workflow_job',
      resourceId: row!.id,
      details: { caseId: job.caseId, jobType: job.jobType },
    });
    return row!;
  }

  /**
   * Reclama hasta `limit` trabajos disponibles en una transacción:
   * `FOR UPDATE OF workflow_jobs SKIP LOCKED` evita que dos consumidores
   * obtengan el mismo trabajo. Disponibles = `pending` con `available_at`
   * cumplido, o `claimed` con el arrendamiento vencido, siempre que queden
   * intentos y el caso siga abierto. Cada reclamación cuenta como un intento.
   *
   * Los casos de un lote se bloquean en orden de id antes de procesarlo: sin un
   * orden global, dos lotes con casos cruzados se interbloquean (40P01). Si un
   * caso se cerró tras elegir el candidato, su trabajo se anula y no se entrega.
   */
  async claim(dto: ClaimJobsDto): Promise<ClaimedJobDto[]> {
    const leaseSeconds = dto.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    // Transacción propia: también bloquea casos y no debe mezclar su orden con
    // el del lote.
    await this.db.transaction((tx) => this.failExhaustedLeases(tx));
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: jobs.id, caseId: jobs.caseId, status: jobs.status })
        .from(jobs)
        .innerJoin(cases, eq(cases.id, jobs.caseId))
        .where(
          and(
            or(
              and(
                eq(jobs.status, 'pending'),
                lte(jobs.availableAt, sql`now()`),
              ),
              and(eq(jobs.status, 'claimed'), lt(jobs.lockedUntil, sql`now()`)),
            ),
            lt(jobs.attempts, jobs.maxAttempts),
            notInArray(cases.status, [...TERMINAL_CASE_STATUSES]),
            dto.jobTypes?.length
              ? inArray(jobs.jobType, dto.jobTypes)
              : undefined,
          ),
        )
        .orderBy(asc(jobs.availableAt), asc(jobs.id))
        .limit(dto.limit ?? DEFAULT_CLAIM_BATCH)
        .for('update', { of: jobs, skipLocked: true });

      const caseIds = [...new Set(candidates.map((c) => c.caseId))].sort();
      for (const caseId of caseIds) await lockCase(tx, caseId);

      const actor: ProcessActor = { kind: 'workflow', workerId: dto.workerId };
      const claimed: ClaimedJobDto[] = [];
      for (const candidate of candidates) {
        const caseRow = await lockCase(tx, candidate.caseId);
        if (caseRow && isTerminalCase(caseRow.status)) {
          await tx
            .update(jobs)
            .set({ status: 'cancelled', lockedUntil: null })
            .where(eq(jobs.id, candidate.id));
          await recordProcessEvent(
            this.audit,
            tx,
            { kind: 'system' },
            {
              ownerId: caseRow.ownerId,
              correlationId: caseRow.correlationId,
              component: COMPONENT,
              action: 'workflow_job.cancel',
              resource: 'workflow_job',
              resourceId: candidate.id,
              details: { caseId: caseRow.id, reason: 'case_closed' },
            },
          );
          continue;
        }

        const claimToken = newClaimToken();
        const [updated] = await tx
          .update(jobs)
          .set({
            status: 'claimed',
            lockedBy: claimFingerprint(dto.workerId, claimToken),
            lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
            attempts: sql`${jobs.attempts} + 1`,
          })
          .where(eq(jobs.id, candidate.id))
          .returning({ id: jobs.id });
        if (!updated) continue;

        if (caseRow?.status === 'received') {
          await transitionCase(tx, this.audit, caseRow, 'processing', actor);
        }
        const job = (await this.selectJob(tx, candidate.id))!;
        await recordProcessEvent(this.audit, tx, actor, {
          ownerId: job.caseOwnerId,
          correlationId: job.caseCorrelationId,
          component: COMPONENT,
          action: 'workflow_job.claim',
          resource: 'workflow_job',
          resourceId: job.id,
          details: {
            caseId: job.caseId,
            jobType: job.jobType,
            attempts: job.attempts,
            leaseRecovered: candidate.status === 'claimed',
          },
        });
        claimed.push({ ...toDto(job), claimToken });
      }
      return claimed;
    });
  }

  /** Detalle de un trabajo para quien tiene su reclamación vigente. */
  async findClaimed(id: string, claimToken: string): Promise<WorkflowJobDto> {
    const job = await this.selectJob(this.db, id);
    if (!job) throw new NotFoundException(JOB_NOT_FOUND);
    if (job.status !== 'claimed' || !matchClaim(job.lockedBy, claimToken)) {
      throw new ConflictException(INVALID_CLAIM);
    }
    if (!job.leaseActive) throw new ConflictException(LEASE_EXPIRED);
    return toDto(job);
  }

  /** Renueva el arrendamiento de una reclamación vigente. No se audita. */
  async heartbeat(id: string, dto: HeartbeatJobDto): Promise<WorkflowJobDto> {
    const leaseSeconds = dto.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    return this.db.transaction(async (tx) => {
      const job = await this.lockActiveJob(tx, id, dto.claimToken);
      await tx
        .update(jobs)
        .set({
          lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
        })
        .where(and(eq(jobs.id, id), eq(jobs.lockedBy, job.lockedBy!)));
      return toDto((await this.selectJob(tx, id))!);
    });
  }

  /**
   * Finaliza el trabajo. Solo el reclamante vigente, con el arrendamiento
   * activo. Repetirlo con la misma reclamación y el mismo resultado devuelve
   * lo ya guardado sin nueva transición; con un resultado distinto, 409 sin
   * cambios. Se compara como `jsonb` en PostgreSQL: el orden de las propiedades
   * no importa, pero sí los valores, los tipos y el orden de los arreglos.
   */
  async complete(id: string, dto: CompleteJobDto): Promise<WorkflowJobDto> {
    return this.db.transaction(async (tx) => {
      const job = await this.lockJob(tx, id);
      const workerId = matchClaim(job.lockedBy, dto.claimToken);
      if (!workerId) throw new ConflictException(INVALID_CLAIM);
      if (job.status === 'completed') {
        const [{ same } = { same: false }] = await tx
          .select({
            same: sql<boolean>`coalesce(${jobs.result}, '{}'::jsonb) = ${JSON.stringify(dto.result ?? {})}::jsonb`,
          })
          .from(jobs)
          .where(eq(jobs.id, id));
        if (!same) throw new ConflictException(CONTRADICTORY_RESULT);
        return toDto(job);
      }
      if (job.status !== 'claimed') {
        throw new ConflictException(
          `El trabajo ya está en estado "${job.status}" para esta reclamación`,
        );
      }
      if (!job.leaseActive) throw new ConflictException(LEASE_EXPIRED);

      const [row] = await tx
        .update(jobs)
        .set({
          status: 'completed',
          completedAt: sql`now()`,
          result: dto.result ?? {},
          lockedUntil: null,
          lastError: null,
        })
        .where(this.stillClaimedBy(job))
        .returning({ id: jobs.id });
      if (!row) throw new ConflictException(INVALID_CLAIM);
      await recordProcessEvent(
        this.audit,
        tx,
        { kind: 'workflow', workerId },
        {
          ownerId: job.caseOwnerId,
          correlationId: job.caseCorrelationId,
          component: COMPONENT,
          action: 'workflow_job.complete',
          resource: 'workflow_job',
          resourceId: id,
          details: {
            caseId: job.caseId,
            jobType: job.jobType,
            attempts: job.attempts,
          },
        },
      );
      return toDto((await this.selectJob(tx, id))!);
    });
  }

  /**
   * Registra un fallo de la reclamación vigente. Con intentos disponibles y
   * `retryable`, el trabajo vuelve a `pending` con espera exponencial; si no,
   * queda `failed` y el caso se cierra como fallido. Un `fail` duplicado de la
   * misma reclamación no vuelve a contar: los intentos se cuentan al reclamar.
   */
  async fail(id: string, dto: FailJobDto): Promise<WorkflowJobDto> {
    return this.db.transaction(async (tx) => {
      const job = await this.lockJob(tx, id);
      const workerId = matchClaim(job.lockedBy, dto.claimToken);
      if (!workerId) throw new ConflictException(INVALID_CLAIM);
      if (
        (job.status === 'pending' || job.status === 'failed') &&
        job.lockedUntil === null
      ) {
        return toDto(job);
      }
      if (job.status !== 'claimed') {
        throw new ConflictException(
          `El trabajo ya está en estado "${job.status}" para esta reclamación`,
        );
      }
      if (!job.leaseActive) throw new ConflictException(LEASE_EXPIRED);

      const retry = dto.retryable !== false && job.attempts < job.maxAttempts;
      const lastError = sanitizeErrorMessage(dto.error);
      const [row] = await tx
        .update(jobs)
        .set({
          status: retry ? 'pending' : 'failed',
          lockedUntil: null,
          lastError,
          ...(retry
            ? {
                availableAt: sql`now() + make_interval(secs => ${retryDelaySeconds(job.attempts)})`,
              }
            : {}),
        })
        .where(this.stillClaimedBy(job))
        .returning({ id: jobs.id });
      if (!row) throw new ConflictException(INVALID_CLAIM);

      const actor: ProcessActor = { kind: 'workflow', workerId };
      await recordProcessEvent(this.audit, tx, actor, {
        ownerId: job.caseOwnerId,
        correlationId: job.caseCorrelationId,
        component: COMPONENT,
        action: 'workflow_job.fail',
        resource: 'workflow_job',
        resourceId: id,
        details: {
          caseId: job.caseId,
          jobType: job.jobType,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          willRetry: retry,
        },
      });
      if (!retry) {
        await this.failCaseOf(tx, job.caseId, actor, job.jobType);
      }
      return toDto((await this.selectJob(tx, id))!);
    });
  }

  /**
   * Verifica, dentro de `tx`, que `token` corresponde a la reclamación vigente
   * del trabajo y que este pertenece a `caseId`. Lo usan las rutas internas de
   * casos para que el servicio solo escriba en casos que está procesando.
   */
  async verifyActiveClaim(
    tx: DbTransaction,
    jobId: string,
    token: string,
    caseId: string,
  ): Promise<ActiveClaim> {
    const job = await this.lockJob(tx, jobId);
    if (job.caseId !== caseId) {
      throw new NotFoundException('El trabajo no pertenece a este caso');
    }
    const active = await this.lockActiveJob(tx, jobId, token, job);
    return {
      jobId,
      caseId,
      jobType: job.jobType,
      workerId: workerOf(active.lockedBy)!,
      ownerId: job.caseOwnerId,
      correlationId: job.caseCorrelationId,
    };
  }

  private async lockActiveJob(
    tx: DbTransaction,
    id: string,
    token: string,
    locked?: JobRow,
  ) {
    const job = locked ?? (await this.lockJob(tx, id));
    if (job.status !== 'claimed' || !matchClaim(job.lockedBy, token)) {
      throw new ConflictException(INVALID_CLAIM);
    }
    if (!job.leaseActive) throw new ConflictException(LEASE_EXPIRED);
    return job;
  }

  /** Trabajos reclamados cuyo arrendamiento venció sin intentos restantes. */
  private async failExhaustedLeases(tx: DbTransaction): Promise<void> {
    const exhausted = await tx
      .select({ id: jobs.id, caseId: jobs.caseId, jobType: jobs.jobType })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'claimed'),
          lt(jobs.lockedUntil, sql`now()`),
          gte(jobs.attempts, jobs.maxAttempts),
        ),
      )
      // Mismo orden global de bloqueo de casos que el lote de reclamación.
      .orderBy(asc(jobs.caseId), asc(jobs.id))
      .limit(20)
      .for('update', { skipLocked: true });
    const actor: ProcessActor = { kind: 'system' };
    for (const job of exhausted) {
      await tx
        .update(jobs)
        .set({
          status: 'failed',
          lockedUntil: null,
          lastError:
            'El arrendamiento venció sin respuesta del worker y no quedan intentos',
        })
        .where(eq(jobs.id, job.id));
      const row = (await this.selectJob(tx, job.id))!;
      await recordProcessEvent(this.audit, tx, actor, {
        ownerId: row.caseOwnerId,
        correlationId: row.caseCorrelationId,
        component: COMPONENT,
        action: 'workflow_job.fail',
        resource: 'workflow_job',
        resourceId: job.id,
        details: {
          caseId: job.caseId,
          jobType: job.jobType,
          reason: 'lease_expired_no_attempts_left',
          willRetry: false,
        },
      });
      await this.failCaseOf(tx, job.caseId, actor, job.jobType);
    }
  }

  private async failCaseOf(
    tx: DbTransaction,
    caseId: string,
    actor: ProcessActor,
    jobType: string,
  ): Promise<void> {
    const caseRow = await lockCase(tx, caseId);
    if (caseRow && !isTerminalCase(caseRow.status)) {
      await transitionCase(
        tx,
        this.audit,
        caseRow,
        'failed',
        actor,
        `La automatización "${jobType}" falló de forma definitiva`,
      );
    }
  }

  private stillClaimedBy(job: JobRow) {
    return and(
      eq(jobs.id, job.id),
      eq(jobs.status, 'claimed'),
      eq(jobs.lockedBy, job.lockedBy!),
      sql`${jobs.lockedUntil} > clock_timestamp()`,
    );
  }

  private async lockJob(tx: DbTransaction, id: string) {
    const [job] = await tx
      .select({ ...jobColumns, ...caseSummary })
      .from(jobs)
      .innerJoin(cases, eq(cases.id, jobs.caseId))
      .where(eq(jobs.id, id))
      .for('update', { of: jobs });
    if (!job) throw new NotFoundException(JOB_NOT_FOUND);
    return { ...job, leaseActive: await this.leaseIsLive(tx, id) };
  }

  /**
   * Vigencia real del arrendamiento en este instante. Debe ser una consulta
   * posterior al bloqueo: `now()` es la hora de inicio de la transacción, y las
   * expresiones de un `SELECT … FOR UPDATE` se calculan antes de esperar la
   * fila, de modo que una operación retenida vería un arrendamiento ya vencido
   * como vigente.
   */
  private async leaseIsLive(tx: DbTransaction, id: string): Promise<boolean> {
    const [row] = await tx
      .select({
        live: sql<boolean>`coalesce(${jobs.lockedUntil} > clock_timestamp(), false)`,
      })
      .from(jobs)
      .where(eq(jobs.id, id));
    return row?.live ?? false;
  }

  /**
   * Revalida el arrendamiento tras esperar otro bloqueo (el del caso). Mantener
   * bloqueado el trabajo impide que otro worker lo reclame, pero la reclamación
   * de este ya no autoriza a escribir si venció durante la espera.
   */
  async assertLeaseStillLive(tx: DbTransaction, id: string): Promise<void> {
    if (!(await this.leaseIsLive(tx, id))) {
      throw new ConflictException(LEASE_EXPIRED);
    }
  }

  private async selectJob(executor: Database | DbTransaction, id: string) {
    const [job] = await executor
      .select({ ...jobColumns, ...caseSummary })
      .from(jobs)
      .innerJoin(cases, eq(cases.id, jobs.caseId))
      .where(eq(jobs.id, id));
    return job;
  }
}

function toDto(job: JobRow): WorkflowJobDto {
  return {
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    payload: job.payload,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    workerId: workerOf(job.lockedBy),
    lockedUntil: job.lockedUntil,
    result: job.result,
    lastError: job.lastError,
    completedAt: job.completedAt,
    case: {
      id: job.caseId,
      correlationId: job.caseCorrelationId,
      type: job.caseType,
      source: job.caseSource,
      status: job.caseStatus,
      obligationId: job.caseObligationId,
      rentalId: job.caseRentalId,
      contractId: job.caseContractId,
    },
  };
}
