import type { Obligation, ObligationOccurrence } from '../../lib/api/types'
import { OBLIGATION_FREQUENCY_LABELS, label } from '../../lib/format/labels'
import { formatMoneyWithCurrency } from '../../lib/format/money'

/**
 * `expected_amount` es el importe BASE con el que la recurrencia genera cada período futuro; una
 * obligación sin generación automática (`autoGenerate = false`) no lo necesita, y su valor real está en
 * cada período. Mostrar «Sin monto» ahí sugeriría que no hay deuda. Además, `frequency` llega con el valor
 * por defecto «mensual» aunque la obligación no se repita: solo se menciona cuando de verdad se genera sola.
 */

type ObligationLike = Pick<Obligation, 'autoGenerate' | 'expectedAmount' | 'currency' | 'frequency' | 'dueDay'>
type OccurrenceLike = Pick<ObligationOccurrence, 'amount' | 'currency' | 'status' | 'dueDate'>

export interface AmountRow {
  label: string
  value: string
  note?: string
}

const OPEN = new Set(['pending', 'overdue'])

export const isRecurring = (o: Pick<Obligation, 'autoGenerate'>) => o.autoGenerate === true

/** Importe que se muestra en «Datos de la obligación». */
export function obligationAmountRow(o: ObligationLike, occurrences: readonly OccurrenceLike[] | undefined): AmountRow {
  if (isRecurring(o)) {
    return o.expectedAmount
      ? { label: 'Monto de cada período', value: formatMoneyWithCurrency(o.expectedAmount, o.currency), note: 'Se usa para generar los próximos períodos.' }
      : { label: 'Monto de cada período', value: 'Se define al registrar cada período', note: 'No hay un importe base: cada período se completa con su factura.' }
  }

  const note = 'Esta obligación no se genera sola: cada período se registra manualmente.'
  if (!occurrences) return { label: 'Importe del período', value: 'Cargando…', note }
  const priced = occurrences.filter((p) => p.amount !== null)
  if (priced.length === 0) return { label: 'Importe del período', value: 'Sin importe registrado', note }
  const open = priced.filter((p) => OPEN.has(p.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const pick = open[0] ?? [...priced].sort((a, b) => b.dueDate.localeCompare(a.dueDate))[0]!
  const only = priced.length === 1
  return {
    label: only ? 'Importe del período' : open[0] ? 'Próximo período por pagar' : 'Último período',
    value: formatMoneyWithCurrency(pick.amount, pick.currency),
    note,
  }
}

/** Texto de la columna «Recurrencia» de la lista. */
export function recurrenceText(o: ObligationLike): string {
  return isRecurring(o) ? `Automática · ${label(OBLIGATION_FREQUENCY_LABELS, o.frequency).toLowerCase()}` : 'Sin repetición automática'
}

/** Importe base para la lista; en obligaciones únicas se remite a los períodos en lugar de decir «Sin monto». */
export function listAmountText(o: ObligationLike): { text: string; muted: boolean } {
  if (o.expectedAmount) return { text: formatMoneyWithCurrency(o.expectedAmount, o.currency), muted: false }
  return { text: isRecurring(o) ? 'Se define en cada período' : 'Según cada período', muted: true }
}
