import { reminderDaysBeforeFromAbsoluteDay } from './reminder-conversion.js';

/** Parámetros de agenda extraídos del mensaje (lo único que la IA aporta). */
export interface ScheduleParams {
  dueDay?: number | null;
  reminderDaysBefore?: number | null;
  reminderDay?: number | null;
  amount?: string | null;
}

export interface ScheduleTarget {
  dueDay: number | null;
  reminderDaysBefore: number;
  expectedAmount: string | null;
}

export interface ScheduleChange {
  expected: Record<string, unknown>;
  changes: Record<string, unknown>;
  warnings: string[];
}

export const hasScheduleParams = (p: ScheduleParams): boolean =>
  p.dueDay != null ||
  p.reminderDaysBefore != null ||
  p.reminderDay != null ||
  p.amount != null;

/**
 * Cambio de agenda de UNA obligación ya identificada: valores vigentes
 * (`expected`, control optimista) y valores nuevos (`changes`). Lo usan el
 * resolver (una sola coincidencia) y la continuación tras elegir entre
 * varias (A-7), de modo que ambos caminos producen exactamente lo mismo.
 */
export function buildScheduleChange(
  obligation: ScheduleTarget,
  p: ScheduleParams,
): ScheduleChange {
  const warnings: string[] = [];
  const expected: Record<string, unknown> = {};
  const changes: Record<string, unknown> = {};
  if (p.dueDay != null) {
    expected.dueDay = obligation.dueDay;
    changes.dueDay = p.dueDay;
  }
  if (p.reminderDaysBefore != null) {
    expected.reminderDaysBefore = obligation.reminderDaysBefore;
    changes.reminderDaysBefore = p.reminderDaysBefore;
  } else if (p.reminderDay != null) {
    const targetDueDay = p.dueDay ?? obligation.dueDay;
    if (targetDueDay == null) {
      warnings.push(
        'No se pudo convertir el aviso porque la obligación no tiene día de vencimiento',
      );
    } else {
      expected.reminderDaysBefore = obligation.reminderDaysBefore;
      changes.reminderDaysBefore = reminderDaysBeforeFromAbsoluteDay(
        targetDueDay,
        p.reminderDay,
      );
    }
  }
  if (p.amount != null) {
    expected.expectedAmount = obligation.expectedAmount;
    changes.expectedAmount = p.amount;
  }
  return { expected, changes, warnings };
}
