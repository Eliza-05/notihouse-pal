import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
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
  obligationOccurrences,
  obligations,
  rentCharges,
  rentals,
} from '../database/schema/index.js';
import { calendarDateIn, yearMonthOf } from '../due-dates/calendar.js';
import { DueDateEvaluationService } from '../due-dates/due-date-evaluation.service.js';
import {
  computeCycle,
  currentCycleIndex,
  RECURRENCE_FREQUENCY_MONTHS,
} from './cycle.js';
import type {
  GenerateRecurrenceDto,
  GenerateRecurrenceResponseDto,
} from './dto/recurrence.dto.js';

const COMPONENT = 'process.recurrence';
const DEFAULT_BATCH = 100;
const DEFAULT_MAX_BATCHES = 20;
/** Clave del bloqueo consultivo que serializa los lotes de generación. */
const RECURRENCE_SWEEP_LOCK = 4_202_002;
/** Ciclo actual y el siguiente (D4): nunca un horizonte indefinido. */
const CYCLES_AHEAD = 2;

const PHASES = ['obligation', 'rental'] as const;
type Phase = (typeof PHASES)[number];

interface Cursor {
  date: string;
  phase: number;
  after: string | null;
}

interface Run {
  today: string;
  timeZone: string;
  actor: ProcessActor;
  correlationId: string;
  batchSize: number;
  counters: Pick<
    GenerateRecurrenceResponseDto,
    'scanned' | 'obligationPeriodsCreated' | 'rentChargesCreated' | 'unchanged'
  > & { missingDueDay: number };
}

/**
 * Generación determinística de períodos y cobros a partir de obligaciones y
 * arriendos con `autoGenerate = true` (§19.4). Nunca toca históricos
 * (`ON CONFLICT DO NOTHING`); el horizonte es siempre el ciclo actual y el
 * siguiente, calculados contra la fecha de referencia de cada corrida (nunca
 * rellena ciclos pasados tras un apagado largo, D3).
 */
@Injectable()
export class RecurrenceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly dueDates: DueDateEvaluationService,
  ) {}

  async generate(
    correlationId: string,
    dto: GenerateRecurrenceDto,
  ): Promise<GenerateRecurrenceResponseDto> {
    const ref = this.dueDates.reference();
    const run: Run = {
      today: ref.today,
      timeZone: this.dueDates.rules.timeZone,
      actor: { kind: 'workflow', workerId: dto.workerId },
      correlationId,
      batchSize: dto.batchSize ?? DEFAULT_BATCH,
      counters: {
        scanned: 0,
        obligationPeriodsCreated: 0,
        rentChargesCreated: 0,
        unchanged: 0,
        missingDueDay: 0,
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
  ): GenerateRecurrenceResponseDto {
    return {
      evaluationDate: run.today,
      timeZone: run.timeZone,
      correlationId: run.correlationId,
      scanned: run.counters.scanned,
      obligationPeriodsCreated: run.counters.obligationPeriodsCreated,
      rentChargesCreated: run.counters.rentChargesCreated,
      unchanged: run.counters.unchanged,
      skipped: { missingDueDay: run.counters.missingDueDay },
      complete,
      nextCursor,
    };
  }

  private async runBatch(
    tx: DbTransaction,
    phase: Phase,
    after: string | null,
    run: Run,
  ): Promise<string | null> {
    // Serializa lotes concurrentes, igual que la evaluación de alertas: dos
    // barridos a la vez no se interbloquean ni se cuentan duplicados.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${RECURRENCE_SWEEP_LOCK}::bigint)`,
    );
    const ids =
      phase === 'obligation'
        ? await this.sweepObligations(tx, after, run)
        : await this.sweepRentals(tx, after, run);
    run.counters.scanned += ids.length;
    return ids.length === run.batchSize ? ids[ids.length - 1]! : null;
  }

  private async sweepObligations(
    tx: DbTransaction,
    after: string | null,
    run: Run,
  ): Promise<string[]> {
    const rows = await tx
      .select({
        id: obligations.id,
        ownerId: obligations.ownerId,
        frequency: obligations.frequency,
        dueDay: obligations.dueDay,
        startsOn: obligations.startsOn,
        createdAt: obligations.createdAt,
        expectedAmount: obligations.expectedAmount,
        currency: obligations.currency,
      })
      .from(obligations)
      .where(
        and(
          eq(obligations.autoGenerate, true),
          eq(obligations.status, 'active'),
          after ? gt(obligations.id, after) : undefined,
        ),
      )
      .orderBy(asc(obligations.id))
      .limit(run.batchSize)
      .for('update');

    for (const row of rows) {
      if (row.dueDay == null) {
        run.counters.missingDueDay += 1;
        continue;
      }
      const anchorDate = row.startsOn ?? calendarDateIn(row.createdAt, run.timeZone);
      const anchor = yearMonthOf(anchorDate);
      const frequencyMonths = RECURRENCE_FREQUENCY_MONTHS[row.frequency];
      const base = currentCycleIndex(anchor, frequencyMonths, yearMonthOf(run.today));
      for (let i = 0; i < CYCLES_AHEAD; i++) {
        const cycle = computeCycle({
          anchor,
          frequencyMonths,
          cycleIndex: base + i,
          dueDay: row.dueDay,
        });
        await this.insertObligationOccurrence(tx, row, cycle, run);
      }
    }
    return rows.map((r) => r.id);
  }

  private async insertObligationOccurrence(
    tx: DbTransaction,
    obligation: {
      id: string;
      ownerId: string;
      expectedAmount: string | null;
      currency: string;
    },
    cycle: { periodStart: string; periodEnd: string; dueDate: string | null },
    run: Run,
  ): Promise<void> {
    const [inserted] = await tx
      .insert(obligationOccurrences)
      .values({
        obligationId: obligation.id,
        ownerId: obligation.ownerId,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        amount: obligation.expectedAmount,
        currency: obligation.currency,
        dueDate: cycle.dueDate!,
        status: 'pending',
      })
      .onConflictDoNothing()
      .returning({ id: obligationOccurrences.id });
    if (inserted) {
      run.counters.obligationPeriodsCreated += 1;
      await recordProcessEvent(this.audit, tx, run.actor, {
        ownerId: obligation.ownerId,
        correlationId: run.correlationId,
        component: COMPONENT,
        action: 'obligation_occurrence.generate',
        resource: 'obligation_occurrence',
        resourceId: inserted.id,
        details: { obligationId: obligation.id, periodStart: cycle.periodStart },
      });
    } else {
      run.counters.unchanged += 1;
    }
  }

  private async sweepRentals(
    tx: DbTransaction,
    after: string | null,
    run: Run,
  ): Promise<string[]> {
    const rows = await tx
      .select({
        id: rentals.id,
        ownerId: rentals.ownerId,
        dueDay: rentals.dueDay,
        startsOn: rentals.startsOn,
        endsOn: rentals.endsOn,
        expectedAmount: rentals.expectedAmount,
        currency: rentals.currency,
      })
      .from(rentals)
      .where(
        and(
          eq(rentals.autoGenerate, true),
          eq(rentals.status, 'active'),
          after ? gt(rentals.id, after) : undefined,
        ),
      )
      .orderBy(asc(rentals.id))
      .limit(run.batchSize)
      .for('update');

    for (const row of rows) {
      const anchor = yearMonthOf(row.startsOn);
      const base = currentCycleIndex(anchor, 1, yearMonthOf(run.today));
      for (let i = 0; i < CYCLES_AHEAD; i++) {
        const cycle = computeCycle({
          anchor,
          frequencyMonths: 1,
          cycleIndex: base + i,
          dueDay: row.dueDay,
          lowerBound: row.startsOn,
        });
        if (row.endsOn && cycle.periodStart > row.endsOn) continue;
        await this.insertRentCharge(tx, row, cycle, run);
      }
    }
    return rows.map((r) => r.id);
  }

  private async insertRentCharge(
    tx: DbTransaction,
    rental: {
      id: string;
      ownerId: string;
      expectedAmount: string;
      currency: string;
    },
    cycle: { periodStart: string; periodEnd: string; dueDate: string | null },
    run: Run,
  ): Promise<void> {
    const [inserted] = await tx
      .insert(rentCharges)
      .values({
        rentalId: rental.id,
        ownerId: rental.ownerId,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        expectedAmount: rental.expectedAmount,
        currency: rental.currency,
        dueDate: cycle.dueDate!,
        status: 'expected',
      })
      .onConflictDoNothing()
      .returning({ id: rentCharges.id });
    if (inserted) {
      run.counters.rentChargesCreated += 1;
      await recordProcessEvent(this.audit, tx, run.actor, {
        ownerId: rental.ownerId,
        correlationId: run.correlationId,
        component: COMPONENT,
        action: 'rent_charge.generate',
        resource: 'rent_charge',
        resourceId: inserted.id,
        details: { rentalId: rental.id, periodStart: cycle.periodStart },
      });
    } else {
      run.counters.unchanged += 1;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    `${cursor.date}|${cursor.phase}|${cursor.after ?? ''}`,
    'utf8',
  ).toString('base64url');
}

/** El cursor solo sirve para continuar el barrido del mismo día. */
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
