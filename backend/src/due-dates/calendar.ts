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
