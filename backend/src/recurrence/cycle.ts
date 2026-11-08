import {
  addMonthsToYearMonth,
  clampedDayInMonth,
  monthRange,
  monthsBetweenYearMonth,
  type YearMonth,
} from '../due-dates/calendar.js';

/**
 * Funciones puras de calendario para la recurrencia (§19.4, D1/D4/D5): el
 * mismo ancla, frecuencia y fecha de referencia siempre producen el mismo
 * ciclo. No leen ni escriben nada.
 */

export const RECURRENCE_FREQUENCY_MONTHS = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
} as const;

export interface RecurrenceCycle {
  periodStart: string;
  periodEnd: string;
  /** `null` si la definición no tiene día de vencimiento (se omite, no se inventa). */
  dueDate: string | null;
}

/**
 * Ciclo `cycleIndex` (0 = el que contiene `anchor`) de `frequencyMonths`
 * meses de ancho. `dueDay` se recorta al último día del primer mes del ciclo
 * (D1). `lowerBound` (cobros de arriendo) evita que `periodStart` quede antes
 * de la vigencia.
 */
export function computeCycle(params: {
  anchor: YearMonth;
  frequencyMonths: number;
  cycleIndex: number;
  dueDay: number | null;
  lowerBound?: string | null;
}): RecurrenceCycle {
  const firstMonth = addMonthsToYearMonth(
    params.anchor,
    params.cycleIndex * params.frequencyMonths,
  );
  const lastMonth = addMonthsToYearMonth(
    firstMonth,
    params.frequencyMonths - 1,
  );
  const firstRange = monthRange(firstMonth);
  const periodEnd = monthRange(lastMonth).end;
  const periodStart =
    params.lowerBound && params.lowerBound > firstRange.start
      ? params.lowerBound
      : firstRange.start;
  const dueDate =
    params.dueDay == null ? null : clampedDayInMonth(firstMonth, params.dueDay);
  return { periodStart, periodEnd, dueDate };
}

/**
 * Índice (≥0) del ciclo que contiene `today`, anclado en `anchor`. Nunca
 * negativo: el primer ciclo no es anterior al ancla (D1.4, "nunca hacia
 * atrás"), lo que también evita rellenar ciclos pasados tras un apagado largo
 * (D3): cada barrido parte de "hoy", no del último que se ejecutó.
 */
export function currentCycleIndex(
  anchor: YearMonth,
  frequencyMonths: number,
  today: YearMonth,
): number {
  const months = monthsBetweenYearMonth(anchor, today);
  if (months < 0) return 0;
  return Math.floor(months / frequencyMonths);
}
