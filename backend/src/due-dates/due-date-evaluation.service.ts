import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { calendarDateIn } from './calendar.js';
import { CLOCK, type Clock } from './clock.js';
import {
  type DueDateRules,
  type DueEvaluation,
  evaluateContract,
  evaluateHitl,
  evaluateOccurrence,
  evaluateOccurrenceAlert,
  evaluateRentCharge,
  type HitlEvaluation,
} from './due-date.rules.js';

/** Fecha de referencia de una evaluación: instante y día civil en la zona del MVP. */
export interface ReferenceTime {
  now: Date;
  today: string;
}

/**
 * Punto único de acceso al motor de vencimientos: umbrales configurados,
 * fecha de referencia (reloj inyectable) y evaluación de cada tipo de
 * registro. Nunca modifica datos.
 */
@Injectable()
export class DueDateEvaluationService {
  readonly rules: DueDateRules;

  constructor(
    config: ConfigService<EnvironmentVariables, true>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.rules = {
      timeZone: config.get('DUE_DATES_TIME_ZONE', { infer: true }),
      obligationDays: config.get('DUE_DATES_OBLIGATION_DAYS', { infer: true }),
      rentChargeDays: config.get('DUE_DATES_RENT_CHARGE_DAYS', {
        infer: true,
      }),
      contractDays: config.get('DUE_DATES_CONTRACT_DAYS', { infer: true }),
      hitlSoonHours: config.get('DUE_DATES_HITL_SOON_HOURS', { infer: true }),
    };
  }

  /** Se toma una sola vez por operación para que todas sus reglas coincidan. */
  reference(): ReferenceTime {
    const now = this.clock.now();
    return { now, today: calendarDateIn(now, this.rules.timeZone) };
  }

  occurrence(
    row: { dueDate: string; status: string; reminderDaysBefore: number },
    today: string,
  ): DueEvaluation {
    return evaluateOccurrence(row, this.rules, today);
  }

  /** D6: ventana personalizada, solo para la alerta de un período. */
  occurrenceAlert(
    row: { dueDate: string; status: string; reminderDaysBefore: number },
    today: string,
  ): DueEvaluation {
    return evaluateOccurrenceAlert(row, today);
  }

  rentCharge(
    row: { dueDate: string; status: string },
    today: string,
  ): DueEvaluation {
    return evaluateRentCharge(row, this.rules, today);
  }

  contract(
    row: { endsOn: string; status: string; noticePeriodDays: number | null },
    today: string,
  ): DueEvaluation {
    return evaluateContract(row, this.rules, today);
  }

  hitl(row: { status: string; dueAt: Date }, now: Date): HitlEvaluation {
    return evaluateHitl(row, this.rules, now);
  }
}
