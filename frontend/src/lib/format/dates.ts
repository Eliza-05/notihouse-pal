import type { CalendarDate, IsoInstant } from '../api/types'

/**
 * Fechas de calendario ("YYYY-MM-DD", sin hora/zona). NUNCA usar
 * `new Date('YYYY-MM-DD')` directo: se interpreta en UTC y puede mostrar el
 * día anterior según la zona del navegador (§4 de la guía). Para mostrar,
 * parseamos los componentes a mano y formateamos con ellos, sin pasar por un
 * `Date` en una zona distinta.
 */
export function formatCalendarDate(date: CalendarDate | null): string {
  if (!date) return '—'
  const [year, month, day] = date.split('-').map(Number)
  const d = new Date(year!, month! - 1, day!)
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Instante ISO 8601 → hora local del usuario (§4: "mostrar en hora local"). */
export function formatInstant(instant: IsoInstant | null): string {
  if (!instant) return '—'
  return new Date(instant).toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Hoy como fecha de calendario local del navegador (para comparar con dueDate). */
export function today(): CalendarDate {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Días entre dos fechas de calendario (negativo si `to` es anterior a `from`). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const a = Date.UTC(fy!, fm! - 1, fd!)
  const b = Date.UTC(ty!, tm! - 1, td!)
  return Math.round((b - a) / 86_400_000)
}

/** "Vence en 3 días" / "Vencido hace 2 días" / "Vence hoy", a partir de una fecha. */
export function describeDueDate(dueDate: CalendarDate): string {
  const diff = daysBetween(today(), dueDate)
  if (diff === 0) return 'Vence hoy'
  if (diff > 0) return `Vence en ${diff} día${diff === 1 ? '' : 's'}`
  return `Vencido hace ${-diff} día${-diff === 1 ? '' : 's'}`
}

export function isPastDue(dueDate: CalendarDate): boolean {
  return daysBetween(today(), dueDate) < 0
}
