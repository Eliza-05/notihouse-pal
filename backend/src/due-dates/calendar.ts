/**
 * Fechas de calendario `YYYY-MM-DD` (vencimientos, cobros, contratos).
 * Nunca se convierten a la hora local del proceso ni del navegador: la
 * aritmética se hace en UTC sobre el día civil, sin componente horario.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Día civil de `instant` en `timeZone` (p. ej. 2026-01-01T03:00Z en Bogotá → 2025-12-31). */
export function calendarDateIn(instant: Date, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // en-CA formatea como YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(instant);
}

function toUtcMidnight(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

const DAY_MS = 86_400_000;

/** Días de `from` a `to` (negativo si `to` es anterior). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMidnight(to) - toUtcMidnight(from)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  return new Date(toUtcMidnight(date) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Primer día del mes de `date` y primer día del mes siguiente. */
export function monthBounds(date: string): { start: string; next: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { start, next };
}

/** Año y mes (1-12) como pareja, para aritmética de ciclos de recurrencia. */
export interface YearMonth {
  year: number;
  month: number;
}

export function yearMonthOf(date: string): YearMonth {
  const [year, month] = date.split('-').map(Number) as [number, number];
  return { year, month };
}

/** Desplaza un año-mes por `months` (puede ser negativo). */
export function addMonthsToYearMonth(ym: YearMonth, months: number): YearMonth {
  const total = ym.year * 12 + (ym.month - 1) + months;
  return { year: Math.floor(total / 12), month: (((total % 12) + 12) % 12) + 1 };
}

/** Meses completos de `a` a `b` (negativo si `b` es anterior a `a`). */
export function monthsBetweenYearMonth(a: YearMonth, b: YearMonth): number {
  return b.year * 12 + b.month - (a.year * 12 + a.month);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function daysInMonth(ym: YearMonth): number {
  return new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
}

/** Primer y último día (`YYYY-MM-DD`) del mes `ym`. */
export function monthRange(ym: YearMonth): { start: string; end: string } {
  const prefix = `${pad(ym.year, 4)}-${pad(ym.month, 2)}`;
  return {
    start: `${prefix}-01`,
    end: `${prefix}-${pad(daysInMonth(ym), 2)}`,
  };
}

/** Día `day` dentro del mes `ym`, recortado al último día si el mes es corto (D1). */
export function clampedDayInMonth(ym: YearMonth, day: number): string {
  const d = Math.min(day, daysInMonth(ym));
  return `${pad(ym.year, 4)}-${pad(ym.month, 2)}-${pad(d, 2)}`;
}
