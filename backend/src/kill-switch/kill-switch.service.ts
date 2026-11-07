import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import { auditEvents } from '../database/schema/index.js';
import {
  jobTypesOfScope,
  KILL_SWITCH_SCOPES,
  type KillSwitchScope,
  SCOPE_LABELS,
  scopeOfJobType,
} from './kill-switch.scopes.js';

export const KILL_SWITCH_COMPONENT = 'ops.kill-switch';
export const KILL_SWITCH_ACTIVE_CODE = 'KILL_SWITCH_ACTIVE';
/** Fallos críticos consecutivos que activan el kill switch (SDD B3). */
export const CRITICAL_FAILURE_THRESHOLD = 3;
/** Serializa activaciones y reanudaciones (y su lectura de estado). */
const KILL_SWITCH_LOCK = 4_207_001;

export type KillSwitchTrigger =
  'manual' | 'consecutive_critical_failures' | 'prohibited_operation';

export interface KillSwitchEntry {
  scope: KillSwitchScope;
  label: string;
  active: boolean;
  /** Último cambio de estado (activación o reanudación). */
  changedAt: Date;
  trigger: KillSwitchTrigger | null;
  reason: string;
  actor: string;
  correlationId: string | null;
}

export interface ActivateKillSwitch {
  scope: KillSwitchScope;
  reason: string;
  trigger: KillSwitchTrigger;
  /** `n8n:<worker>`, `api` u `operador:<nombre>`. */
  actor: string;
  actorType: 'workflow' | 'system';
  evidence?: Record<string, unknown>;
}

export interface ResumeKillSwitch {
  scope: KillSwitchScope;
  /** Responsable operativo que autoriza la reanudación. */
  operator: string;
  /** Causa identificada y corregida. */
  reason: string;
  /** Prueba controlada ejecutada antes de reanudar (SDD §6). */
  testEvidence: string;
}

type Executor = Database | DbTransaction;

/** Respuesta 503 uniforme: la función está limitada, no rota. */
export class KillSwitchActiveException extends HttpException {
  constructor(scope: KillSwitchScope) {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        code: KILL_SWITCH_ACTIVE_CODE,
        scope,
        message: `Función temporalmente limitada por el kill switch: ${SCOPE_LABELS[scope]}. Los datos registrados siguen disponibles.`,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * Kill switch del SDD (§6 "Contención"): evento, actor, alcance, notificación
 * y reanudación. El estado NO vive en una tabla propia: es el último evento
 * `kill_switch.activate` / `kill_switch.resume` de cada alcance en
 * `audit_events`, que es append-only (un trigger impide UPDATE y DELETE). Así,
 * cada activación y reanudación queda trazada por construcción y no hace
 * falta ninguna migración.
 *
 * Mientras un alcance está activo se rechazan (503) las escrituras
 * automáticas de su componente y las reclamaciones de sus trabajos; las
 * lecturas y las acciones manuales del usuario siguen disponibles.
 */
@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger('KillSwitch');

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Estado de todos los alcances (el último evento de cada uno). */
  async state(executor: Executor = this.db): Promise<KillSwitchEntry[]> {
    const rows = await executor
      .select({
        action: auditEvents.action,
        occurredAt: auditEvents.occurredAt,
        actorId: auditEvents.actorId,
        correlationId: auditEvents.correlationId,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.component, KILL_SWITCH_COMPONENT),
          inArray(auditEvents.action, [
            'kill_switch.activate',
            'kill_switch.resume',
          ]),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id));
    const latest = new Map<KillSwitchScope, KillSwitchEntry>();
    for (const row of rows) {
      const meta = row.metadata as Record<string, unknown>;
      const scope = meta.scope as KillSwitchScope;
      if (!KILL_SWITCH_SCOPES.includes(scope) || latest.has(scope)) continue;
      const active = row.action === 'kill_switch.activate';
      latest.set(scope, {
        scope,
        label: SCOPE_LABELS[scope],
        active,
        changedAt: row.occurredAt,
        trigger: active ? ((meta.trigger as KillSwitchTrigger) ?? null) : null,
        reason: String(meta.reason ?? ''),
        actor: row.actorId ?? '',
        correlationId: row.correlationId,
      });
    }
    return [...latest.values()];
  }

  async activeScopes(executor: Executor = this.db): Promise<KillSwitchScope[]> {
    return (await this.state(executor))
      .filter((e) => e.active)
      .map((e) => e.scope);
  }

  /** ¿Está detenido este alcance (directamente o por el global)? */
  async isSuspended(
    scope: KillSwitchScope,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const active = await this.activeScopes(executor);
    return active.includes('global') || active.includes(scope);
  }

  async assertActive(
    scope: KillSwitchScope,
    executor: Executor = this.db,
  ): Promise<void> {
    if (await this.isSuspended(scope, executor)) {
      throw new KillSwitchActiveException(scope);
    }
  }

  /** Para escrituras del servicio sobre un trabajo ya reclamado. */
  assertJobTypeActive(jobType: string, executor: Executor = this.db) {
    return this.assertActive(scopeOfJobType(jobType), executor);
  }

  /**
   * Restricción para la reclamación: `null` = no se puede reclamar nada
   * (global activo); si no, los tipos de trabajo excluidos y si se excluyen
   * los casos genéricos (`case.*`).
   */
  async claimExclusions(
    executor: Executor = this.db,
  ): Promise<{ jobTypes: string[]; casePrefix: boolean } | null> {
    const active = await this.activeScopes(executor);
    if (active.includes('global')) return null;
    return {
      jobTypes: active.flatMap(jobTypesOfScope),
      casePrefix: active.includes('case_processing'),
    };
  }

  /**
   * Activa el alcance. Idempotente: si ya estaba activo no registra otro
   * evento. Se ejecuta en `executor` (puede ser la transacción del fallo que
   * lo provoca, para que ambos queden confirmados juntos).
   */
  async activate(
    input: ActivateKillSwitch,
    executor?: DbTransaction,
  ): Promise<{ entry: KillSwitchEntry; changed: boolean }> {
    const run = async (tx: DbTransaction) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${KILL_SWITCH_LOCK}::bigint)`,
      );
      const current = (await this.state(tx)).find(
        (e) => e.scope === input.scope,
      );
      if (current?.active) return { entry: current, changed: false };
      const correlationId = randomUUID();
      await tx.insert(auditEvents).values({
        correlationId,
        ownerId: null,
        actorType: input.actorType,
        actorId: input.actor.slice(0, 120),
        component: KILL_SWITCH_COMPONENT,
        action: 'kill_switch.activate',
        result: 'success',
        // Después del bloqueo: el orden de los eventos es el orden real.
        occurredAt: sql`clock_timestamp()`,
        metadata: {
          scope: input.scope,
          trigger: input.trigger,
          reason: input.reason.slice(0, 500),
          suspends: 'escrituras automáticas y acciones externas del componente',
          ...(input.evidence ? { evidence: input.evidence } : {}),
        },
      });
      const entry = (await this.state(tx)).find(
        (e) => e.scope === input.scope,
      )!;
      // Canal de notificación del MVP: log de observabilidad (Render) con
      // prefijo fijo + auditoría + estado consultable. Sin push externo.
      this.logger.error(
        `[KILL-SWITCH] ACTIVADO alcance=${input.scope} disparador=${input.trigger} actor=${input.actor} correlation=${correlationId} motivo=${input.reason.slice(0, 200)}`,
      );
      return { entry, changed: true };
    };
    return executor ? run(executor) : this.db.transaction(run);
  }

  /**
   * Reanudación controlada: solo la invoca el responsable operativo (script
   * de operación con credenciales de la base), con la causa corregida y la
   * evidencia de una prueba controlada. Nunca hay una ruta HTTP para esto.
   */
  async resume(
    input: ResumeKillSwitch,
  ): Promise<{ entry: KillSwitchEntry | null; changed: boolean }> {
    for (const [field, value] of Object.entries({
      operator: input.operator,
      reason: input.reason,
      testEvidence: input.testEvidence,
    })) {
      if (!value || value.trim().length < 3) {
        throw new Error(`La reanudación exige ${field} (mínimo 3 caracteres)`);
      }
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${KILL_SWITCH_LOCK}::bigint)`,
      );
      const current = (await this.state(tx)).find(
        (e) => e.scope === input.scope,
      );
      if (!current?.active) return { entry: current ?? null, changed: false };
      await tx.insert(auditEvents).values({
        correlationId: current.correlationId,
        ownerId: null,
        actorType: 'system',
        actorId: `operador:${input.operator.trim().slice(0, 80)}`,
        component: KILL_SWITCH_COMPONENT,
        action: 'kill_switch.resume',
        result: 'success',
        occurredAt: sql`clock_timestamp()`,
        metadata: {
          scope: input.scope,
          reason: input.reason.slice(0, 500),
          testEvidence: input.testEvidence.slice(0, 500),
          activatedAt: current.changedAt.toISOString(),
          activationTrigger: current.trigger,
        },
      });
      this.logger.warn(
        `[KILL-SWITCH] REANUDADO alcance=${input.scope} operador=${input.operator} correlation=${current.correlationId}`,
      );
      return {
        entry: (await this.state(tx)).find((e) => e.scope === input.scope)!,
        changed: true,
      };
    });
  }

  /**
   * Regla K2: tres fallos críticos consecutivos del mismo componente activan
   * su kill switch. Crítico = fallo técnico que agotó los reintentos o un
   * worker que dejó vencer su último arrendamiento; un rechazo por contenido
   * (`retryable: false`, p. ej. un audio sin voz) no es crítico y corta la
   * racha, igual que un trabajo completado.
   */
  async evaluateCriticalStreak(
    tx: DbTransaction,
    jobType: string,
    actor: string,
  ): Promise<boolean> {
    const scope = scopeOfJobType(jobType);
    if (scope === 'global') return false;
    // Serializa la evaluación: con READ COMMITTED, tres fallos que confirman a
    // la vez podrían no verse entre sí y ninguno completaría la racha. Tras
    // esperar el bloqueo, esta transacción ve los fallos ya confirmados.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${KILL_SWITCH_LOCK}::bigint)`,
    );
    const types = jobTypesOfScope(scope);
    const typeFilter =
      scope === 'case_processing'
        ? sql`${auditEvents.metadata}->>'jobType' LIKE 'case.%'`
        : inArray(sql<string>`${auditEvents.metadata}->>'jobType'`, types);
    // Una reanudación significa que la causa se corrigió: la racha empieza de
    // cero y los fallos anteriores ya no cuentan.
    const lastChange = (await this.state(tx)).find((e) => e.scope === scope);
    if (lastChange?.active) return false;
    const recent = await tx
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.component, 'api.workflow-jobs'),
          lastChange
            ? gt(auditEvents.occurredAt, lastChange.changedAt)
            : undefined,
          sql`(${auditEvents.action} = 'workflow_job.complete' OR (${auditEvents.action} = 'workflow_job.fail' AND ${auditEvents.metadata}->>'willRetry' = 'false'))`,
          typeFilter,
        ),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(CRITICAL_FAILURE_THRESHOLD);
    const streak =
      recent.length === CRITICAL_FAILURE_THRESHOLD &&
      recent.every(
        (r) =>
          r.action === 'workflow_job.fail' &&
          (r.metadata as Record<string, unknown>).critical === true,
      );
    if (!streak) return false;
    const { changed } = await this.activate(
      {
        scope,
        trigger: 'consecutive_critical_failures',
        reason: `${CRITICAL_FAILURE_THRESHOLD} fallos críticos consecutivos de "${jobType}"`,
        actor,
        actorType: 'system',
        evidence: { jobType, threshold: CRITICAL_FAILURE_THRESHOLD },
      },
      tx,
    );
    return changed;
  }
}
