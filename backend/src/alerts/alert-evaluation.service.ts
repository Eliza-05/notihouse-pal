import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service.js';
import {
  type ProcessActor,
  recordProcessEvent,
} from '../audit/process-actor.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import {
  alerts,
  contracts,
  hitlRequests,
  obligationOccurrences as occurrences,
  obligations,
  rentCharges,
} from '../database/schema/index.js';
import { calendarDateIn } from '../due-dates/calendar.js';
import {
  DueDateEvaluationService,
  type ReferenceTime,
} from '../due-dates/due-date-evaluation.service.js';
import {
  type DueItemKind,
  OPEN_STATUSES,
} from '../due-dates/due-date.rules.js';
import { type DesiredAlert, desiredAlert } from './alert-rules.js';
import type {
  EvaluateAlertsDto,
  EvaluateAlertsResponseDto,
} from './dto/alert.dto.js';

const COMPONENT = 'process.alerts';
const DEFAULT_BATCH = 100;
const DEFAULT_MAX_BATCHES = 20;
/** Clave del bloqueo consultivo que serializa los lotes de evaluación. */
const ALERT_SWEEP_LOCK = 4_202_001;

/**
 * Fases de un barrido, en orden. Las cuatro primeras crean o escalan alertas
 * a partir de los registros abiertos; `resolve` cierra las alertas activas que
 * ya no corresponden a su recurso.
 */
const PHASES = [
  ...(Object.keys(OPEN_STATUSES) as DueItemKind[]),
  'resolve',
] as const;
type Phase = (typeof PHASES)[number];

interface Cursor {
  date: string;
  phase: number;
  after: string | null;
}

interface Run {
  ref: ReferenceTime;
  actor: ProcessActor;
  correlationId: string;
  batchSize: number;
  counters: Pick<
    EvaluateAlertsResponseDto,
    'scanned' | 'created' | 'reactivated' | 'resolved' | 'unchanged'
  >;
}

const RESOURCE_COLUMN = {
  obligation_occurrence: alerts.occurrenceId,
  rent_charge: alerts.rentChargeId,
  contract: alerts.contractId,
  hitl_request: alerts.hitlRequestId,
} as const;

const RESOURCE_FIELD = {
  obligation_occurrence: 'occurrenceId',
  rent_charge: 'rentChargeId',
  contract: 'contractId',
  hitl_request: 'hitlRequestId',
} as const;

/**
 * Evaluación programable de alertas (operación de servicio, alcance: todas
 * las cuentas). Solo escribe en `alerts` y `audit_events`: nunca modifica
 * períodos, cobros, contratos ni revisiones, y no envía notificaciones.
 * Cada lote es una transacción corta; las claves de deduplicación y el índice
 * de "una alerta activa por recurso" hacen que repetir el barrido (o
 * ejecutarlo en paralelo) no multiplique alertas.
 */
@Injectable()
export class AlertEvaluationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly dueDates: DueDateEvaluationService,
  ) {}

  async evaluate(
    correlationId: string,
    dto: EvaluateAlertsDto,
  ): Promise<EvaluateAlertsResponseDto> {
    const ref = this.dueDates.reference();
    const run: Run = {
      ref,
      actor: { kind: 'workflow', workerId: dto.workerId },
      correlationId,
      batchSize: dto.batchSize ?? DEFAULT_BATCH,
      counters: {
        scanned: 0,
        created: 0,
        reactivated: 0,
        resolved: 0,
        unchanged: 0,
      },
    };
    const maxBatches = dto.maxBatches ?? DEFAULT_MAX_BATCHES;
    const cursor = dto.cursor
      ? decodeCursor(dto.cursor, ref.today)
      : { date: ref.today, phase: 0, after: null };

    for (let batches = 0; cursor.phase < PHASES.length; batches++) {
      if (batches >= maxBatches) {
        return this.summary(run, false, encodeCursor(cursor));
      }
      const last = await this.db.transaction((tx) =>
        this.runBatch(tx, PHASES[cursor.phase]!, cursor.after, run),
      );
      if (last === null) {
        cursor.phase += 1;
        cursor.after = null;
      } else {
        cursor.after = last;
      }
    }
    return this.summary(run, true, null);
  }

  private summary(
    run: Run,
    complete: boolean,
    nextCursor: string | null,
  ): EvaluateAlertsResponseDto {
    return {
      evaluationDate: run.ref.today,
      timeZone: this.dueDates.rules.timeZone,
      correlationId: run.correlationId,
      ...run.counters,
      complete,
      nextCursor,
    };
  }

  /** Procesa un lote; devuelve el último id si el lote estaba lleno. */
  private async runBatch(
    tx: DbTransaction,
    phase: Phase,
    after: string | null,
    run: Run,
  ): Promise<string | null> {
    // Las fases bloquean alertas en órdenes distintos (por recurso y por id de
    // alerta): dos barridos en paralelo se interbloquean (40P01). Se serializan
    // los lotes; cada uno sigue siendo una transacción corta, y la consulta
    // siguiente ya ve lo que confirmó el lote anterior.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ALERT_SWEEP_LOCK}::bigint)`,
    );
    const ids =
      phase === 'resolve'
        ? await this.resolveBatch(tx, after, run)
        : await this.syncBatch(tx, phase, after, run);
    run.counters.scanned += ids.length;
    return ids.length === run.batchSize ? ids[ids.length - 1]! : null;
  }

  /** Registros abiertos dentro del umbral → alerta correspondiente. */
  private async syncBatch(
    tx: DbTransaction,
    kind: DueItemKind,
    after: string | null,
    run: Run,
  ): Promise<string[]> {
    const { today, now } = run.ref;
    const rules = this.dueDates.rules;
    const afterId = (column: AnyPgColumn) =>
      after ? gt(column, after) : undefined;

    let candidates: {
      id: string;
      ownerId: string;
      desired: DesiredAlert | null;
    }[];
    switch (kind) {
      case 'obligation_occurrence': {
        const rows = await tx
          .select({
            id: occurrences.id,
            ownerId: occurrences.ownerId,
            dueDate: occurrences.dueDate,
            status: occurrences.status,
            reminderDaysBefore: obligations.reminderDaysBefore,
          })
          .from(occurrences)
          .innerJoin(obligations, eq(obligations.id, occurrences.obligationId))
          .where(
            and(
              inArray(occurrences.status, [
                ...OPEN_STATUSES.obligation_occurrence,
              ]),
              lte(
                occurrences.dueDate,
                sql`${today}::date + greatest(${rules.obligationDays}::int, ${obligations.reminderDaysBefore})`,
              ),
              afterId(occurrences.id),
            ),
          )
          .orderBy(asc(occurrences.id))
          .limit(run.batchSize);
        candidates = rows.map((r) => ({
          id: r.id,
          ownerId: r.ownerId,
          // D6: la alerta usa la ventana personalizada (reminderDaysBefore
          // solo), no la general de la bandeja/dashboard.
          desired: desiredAlert(
            kind,
            r.id,
            r.dueDate,
            this.dueDates.occurrenceAlert(r, today).condition,
          ),
        }));
        break;
      }
      case 'rent_charge': {
        const rows = await tx
          .select({
            id: rentCharges.id,
            ownerId: rentCharges.ownerId,
            dueDate: rentCharges.dueDate,
            status: rentCharges.status,
          })
          .from(rentCharges)
          .where(
            and(
              inArray(rentCharges.status, [...OPEN_STATUSES.rent_charge]),
              lte(
                rentCharges.dueDate,
                sql`${today}::date + ${rules.rentChargeDays}::int`,
              ),
              afterId(rentCharges.id),
            ),
          )
          .orderBy(asc(rentCharges.id))
          .limit(run.batchSize);
        candidates = rows.map((r) => ({
          id: r.id,
          ownerId: r.ownerId,
          desired: desiredAlert(
            kind,
            r.id,
            r.dueDate,
            this.dueDates.rentCharge(r, today).condition,
          ),
        }));
        break;
      }
      case 'contract': {
        const rows = await tx
          .select({
            id: contracts.id,
            ownerId: contracts.ownerId,
            endsOn: contracts.endsOn,
            status: contracts.status,
            noticePeriodDays: contracts.noticePeriodDays,
          })
          .from(contracts)
          .where(
            and(
              inArray(contracts.status, [...OPEN_STATUSES.contract]),
              lte(
                contracts.endsOn,
                sql`${today}::date + greatest(${rules.contractDays}::int, coalesce(${contracts.noticePeriodDays}, 0))`,
              ),
              afterId(contracts.id),
            ),
          )
          .orderBy(asc(contracts.id))
          .limit(run.batchSize);
        candidates = rows.map((r) => ({
          id: r.id,
          ownerId: r.ownerId,
          desired: desiredAlert(
            kind,
            r.id,
            r.endsOn,
            this.dueDates.contract(r, today).condition,
          ),
        }));
        break;
      }
      case 'hitl_request': {
        const rows = await tx
          .select({
            id: hitlRequests.id,
            ownerId: hitlRequests.ownerId,
            dueAt: hitlRequests.dueAt,
            status: hitlRequests.status,
          })
          .from(hitlRequests)
          .where(
            and(
              inArray(hitlRequests.status, [...OPEN_STATUSES.hitl_request]),
              afterId(hitlRequests.id),
            ),
          )
          .orderBy(asc(hitlRequests.id))
          .limit(run.batchSize);
        candidates = rows.map((r) => ({
          id: r.id,
          ownerId: r.ownerId,
          desired: desiredAlert(
            kind,
            r.id,
            calendarDateIn(r.dueAt, rules.timeZone),
            this.dueDates.hitl(r, now).condition,
          ),
        }));
        break;
      }
    }

    for (const candidate of candidates) {
      if (candidate.desired) {
        await this.syncAlert(tx, candidate.ownerId, candidate.desired, run);
      }
    }
    return candidates.map((c) => c.id);
  }

  /**
   * Deja exactamente una alerta activa con la clave deseada para el recurso.
   * Las activas con otra clave (etapa o fecha anterior) se resuelven primero,
   * bajo bloqueo; la inserción usa ON CONFLICT DO NOTHING sobre las
   * restricciones únicas, de modo que un barrido simultáneo nunca duplica.
   */
  private async syncAlert(
    tx: DbTransaction,
    ownerId: string,
    desired: DesiredAlert,
    run: Run,
  ): Promise<void> {
    const column = RESOURCE_COLUMN[desired.kind];
    const active = await tx
      .select({ id: alerts.id, dedupKey: alerts.dedupKey, type: alerts.type })
      .from(alerts)
      .where(and(eq(column, desired.resourceId), eq(alerts.state, 'active')))
      .for('update');
    if (active.some((a) => a.dedupKey === desired.dedupKey)) {
      run.counters.unchanged += 1;
      return;
    }
    for (const old of active) {
      await this.resolveAlert(tx, { ...old, ownerId }, 'superseded', run);
    }

    const [inserted] = await tx
      .insert(alerts)
      .values({
        ownerId,
        type: desired.type,
        severity: desired.severity,
        [RESOURCE_FIELD[desired.kind]]: desired.resourceId,
        relevantDate: desired.relevantDate,
        dedupKey: desired.dedupKey,
        state: 'active',
      })
      .onConflictDoNothing()
      .returning({ id: alerts.id });
    if (inserted) {
      run.counters.created += 1;
      await this.record(tx, run, ownerId, 'alert.create', inserted.id, {
        type: desired.type,
        resourceType: desired.kind,
        relevantDate: desired.relevantDate,
      });
      return;
    }

    // La clave ya existe: si se resolvió antes (p. ej. la fecha volvió a su
    // valor original), se reactiva; si el usuario la descartó, se respeta.
    const [reactivated] = await tx
      .update(alerts)
      .set({ state: 'active', resolvedAt: null, resolutionReason: null })
      .where(
        and(
          eq(alerts.ownerId, ownerId),
          eq(alerts.dedupKey, desired.dedupKey),
          eq(alerts.state, 'resolved'),
        ),
      )
      .returning({ id: alerts.id });
    if (reactivated) {
      run.counters.reactivated += 1;
      await this.record(tx, run, ownerId, 'alert.reactivate', reactivated.id, {
        type: desired.type,
        relevantDate: desired.relevantDate,
      });
    } else {
      run.counters.unchanged += 1;
    }
  }

  /** Alertas activas cuyo recurso ya no justifica esa misma alerta. */
  private async resolveBatch(
    tx: DbTransaction,
    after: string | null,
    run: Run,
  ): Promise<string[]> {
    const { today, now } = run.ref;
    const rows = await tx
      .select({
        id: alerts.id,
        ownerId: alerts.ownerId,
        type: alerts.type,
        dedupKey: alerts.dedupKey,
        occurrenceId: alerts.occurrenceId,
        rentChargeId: alerts.rentChargeId,
        contractId: alerts.contractId,
        hitlRequestId: alerts.hitlRequestId,
        occurrenceDue: occurrences.dueDate,
        occurrenceStatus: occurrences.status,
        reminderDaysBefore: obligations.reminderDaysBefore,
        chargeDue: rentCharges.dueDate,
        chargeStatus: rentCharges.status,
        contractEnds: contracts.endsOn,
        contractStatus: contracts.status,
        noticePeriodDays: contracts.noticePeriodDays,
        hitlDueAt: hitlRequests.dueAt,
        hitlStatus: hitlRequests.status,
      })
      .from(alerts)
      .leftJoin(occurrences, eq(occurrences.id, alerts.occurrenceId))
      .leftJoin(obligations, eq(obligations.id, occurrences.obligationId))
      .leftJoin(rentCharges, eq(rentCharges.id, alerts.rentChargeId))
      .leftJoin(contracts, eq(contracts.id, alerts.contractId))
      .leftJoin(hitlRequests, eq(hitlRequests.id, alerts.hitlRequestId))
      .where(
        and(
          eq(alerts.state, 'active'),
          after ? gt(alerts.id, after) : undefined,
        ) as SQL,
      )
      .orderBy(asc(alerts.id))
      .limit(run.batchSize)
      .for('update', { of: alerts });

    for (const row of rows) {
      let desired: DesiredAlert | null;
      let closed: boolean;
      if (row.occurrenceId) {
        // D6: la misma ventana personalizada que decidió crearla decide si
        // sigue vigente; si no, se resuelve (evita un bucle crea/resuelve).
        const e = this.dueDates.occurrenceAlert(
          {
            dueDate: row.occurrenceDue!,
            status: row.occurrenceStatus!,
            reminderDaysBefore: row.reminderDaysBefore!,
          },
          today,
        );
        closed = e.condition === 'resolved';
        desired = desiredAlert(
          'obligation_occurrence',
          row.occurrenceId,
          row.occurrenceDue!,
          e.condition,
        );
      } else if (row.rentChargeId) {
        const e = this.dueDates.rentCharge(
          { dueDate: row.chargeDue!, status: row.chargeStatus! },
          today,
        );
        closed = e.condition === 'resolved';
        desired = desiredAlert(
          'rent_charge',
          row.rentChargeId,
          row.chargeDue!,
          e.condition,
        );
      } else if (row.contractId) {
        const e = this.dueDates.contract(
          {
            endsOn: row.contractEnds!,
            status: row.contractStatus!,
            noticePeriodDays: row.noticePeriodDays,
          },
          today,
        );
        closed = e.condition === 'resolved';
        desired = desiredAlert(
          'contract',
          row.contractId,
          row.contractEnds!,
          e.condition,
        );
      } else {
        const e = this.dueDates.hitl(
          { dueAt: row.hitlDueAt!, status: row.hitlStatus! },
          now,
        );
        closed = e.condition === 'resolved';
        desired = desiredAlert(
          'hitl_request',
          row.hitlRequestId!,
          calendarDateIn(row.hitlDueAt!, this.dueDates.rules.timeZone),
          e.condition,
        );
      }

      if (desired?.dedupKey === row.dedupKey) {
        run.counters.unchanged += 1;
        continue;
      }
      await this.resolveAlert(
        tx,
        row,
        closed
          ? 'resource_closed'
          : desired
            ? 'superseded'
            : 'no_longer_applicable',
        run,
      );
    }
    return rows.map((r) => r.id);
  }

  private async resolveAlert(
    tx: DbTransaction,
    alert: { id: string; ownerId: string; type: string },
    reason: 'resource_closed' | 'superseded' | 'no_longer_applicable',
    run: Run,
  ): Promise<void> {
    const [row] = await tx
      .update(alerts)
      .set({
        state: 'resolved',
        resolvedAt: sql`now()`,
        resolutionReason: reason,
      })
      .where(and(eq(alerts.id, alert.id), eq(alerts.state, 'active')))
      .returning({ id: alerts.id });
    if (!row) return;
    run.counters.resolved += 1;
    await this.record(tx, run, alert.ownerId, 'alert.resolve', alert.id, {
      type: alert.type,
      reason,
    });
  }

  private record(
    tx: DbTransaction,
    run: Run,
    ownerId: string,
    action: string,
    alertId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    return recordProcessEvent(this.audit, tx, run.actor, {
      ownerId,
      correlationId: run.correlationId,
      component: COMPONENT,
      action,
      resource: 'alert',
      resourceId: alertId,
      details: { ...details, evaluationDate: run.ref.today },
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    `${cursor.date}|${cursor.phase}|${cursor.after ?? ''}`,
    'utf8',
  ).toString('base64url');
}

/**
 * El cursor solo sirve para continuar el barrido del mismo día: si cambió la
 * fecha de referencia, la evaluación debe empezar de nuevo.
 */
export function decodeCursor(value: string, today: string): Cursor {
  const [date, phase, after, ...rest] = Buffer.from(value, 'base64url')
    .toString('utf8')
    .split('|');
  const phaseIndex = Number(phase);
  if (
    rest.length > 0 ||
    date !== today ||
    !/^\d$/.test(phase ?? '') ||
    phaseIndex >= PHASES.length ||
    (after !== '' && !UUID.test(after ?? ''))
  ) {
    throw new BadRequestException(
      'cursor inválido o de otra fecha de evaluación; inicia un barrido nuevo',
    );
  }
  return { date, phase: phaseIndex, after: after || null };
}
