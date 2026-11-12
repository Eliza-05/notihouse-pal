import type { HitlDetail } from '../../lib/api/types'
import { formatLongDate } from '../../lib/format/dates'
import { formatMoney } from '../../lib/format/money'
import { HITL_DECISION_TYPE_LABELS, label } from '../../lib/format/labels'
import type { ParsedProposal } from './proposalSchema'
import { humanizeFieldKeys, reviewMode } from './reviewMode'

/**
 * Convierte importes y fechas técnicas dentro de un texto libre (p. ej. el resumen que
 * redacta el flujo de n8n) a la forma colombiana: «87400.00» → «$87.400»,
 * «2026-12-22» → «22 de diciembre de 2026». No toca números que no sean importes con decimales.
 */
export function humanizeText(text: string): string {
  return text
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (_, d: string) => formatLongDate(d))
    .replace(/(?<![\d.,])(\d{1,12}\.\d{2})(?![\d.])/g, (_, m: string) => formatMoney(m, 'COP'))
}

export interface ReviewHeading {
  /** Título corto que distingue una revisión de otra («Revisar factura de Aseo Verde — $87.400»). */
  title: string
  /** Frase breve con lo que se propone, sin tecnicismos. */
  description: string
  /** Proveedor/concepto principal cuando existe. */
  subject?: string
  amount?: string | null
}

const short = (s: string, max = 38) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

/**
 * Título y descripción de una revisión a partir de su propuesta (la fuente fiable), con
 * el resumen del flujo como respaldo. Evita que dos revisiones se llamen igual.
 */
export function reviewHeading(
  hitl: Pick<HitlDetail, 'decisionType' | 'options' | 'proposal'>,
  parsed: ParsedProposal | null,
): ReviewHeading {
  const mode = reviewMode(hitl, parsed)
  const fallbackTitle = label(HITL_DECISION_TYPE_LABELS, hitl.decisionType)
  const summary = hitl.options.summary ? humanizeText(humanizeFieldKeys(hitl.options.summary)) : ''

  if (parsed?.kind === 'known' && mode === 'applicable') {
    const v = parsed.value
    const fromDocument = hitl.proposal?.documentId != null
    switch (v.action) {
      case 'create_obligation_with_occurrence': {
        const provider = v.data.obligation.providerName
        const amount = v.data.occurrence.amount ?? null
        const money = amount ? formatMoney(amount, v.data.occurrence.currency ?? v.data.obligation.currency ?? 'COP') : null
        return {
          title: `${fromDocument ? 'Revisar factura de' : 'Registrar obligación de'} ${short(provider)}${money ? ` — ${money}` : ''}`,
          description: `Se registrará una obligación de ${provider}${money ? ` por ${money}` : ''}, con vencimiento el ${formatLongDate(v.data.occurrence.dueDate)}.`,
          subject: provider,
          amount,
        }
      }
      case 'create_obligation_occurrence': {
        const amount = v.data.amount ?? null
        const money = amount ? formatMoney(amount, v.data.currency ?? 'COP') : null
        return {
          title: `${fromDocument ? 'Revisar factura' : 'Registrar período'}${money ? ` — ${money}` : ''}`,
          description: `Se agregará un período${money ? ` de ${money}` : ''}, con vencimiento el ${formatLongDate(v.data.dueDate)}.`,
          amount,
        }
      }
      case 'create_recurring_obligation': {
        const o = v.data.obligation
        const money = o.expectedAmount ? formatMoney(o.expectedAmount, o.currency ?? 'COP') : null
        return {
          title: `Confirmar obligación recurrente ${short(o.providerName)}${money ? ` — ${money}` : ''}`,
          description: `Se creará una obligación recurrente de ${o.providerName} que vence el día ${o.dueDay} de cada ciclo${money ? `, por ${money}` : ''}.`,
          subject: o.providerName,
          amount: o.expectedAmount ?? null,
        }
      }
      case 'update_obligation_schedule': {
        const amt = v.data.changes.expectedAmount ?? null
        return {
          title: `Confirmar cambio de una obligación${amt ? ` — ${formatMoney(amt, 'COP')}` : ''}`,
          description: 'Se actualizarán las fechas o el monto base de una obligación existente.',
          amount: amt,
        }
      }
      case 'update_occurrence_details': {
        const amt = v.data.amount ?? null
        return {
          title: `Completar datos de un período${amt ? ` — ${formatMoney(amt, 'COP')}` : ''}`,
          description: 'Se completará el monto o el vencimiento de un período pendiente. No confirma ningún pago.',
          amount: amt,
        }
      }
      case 'archive_obligation': {
        const { providerName, concept } = v.data.expected
        return {
          title: `Archivar obligación de ${short(providerName)}`,
          description: `Se archivará la obligación de ${providerName} (${concept}). Dejará de generar períodos nuevos y se conserva todo su historial.`,
          subject: providerName,
        }
      }
      case 'create_recurring_rental': {
        const r = v.data.rental
        return {
          title: `Confirmar arriendo recurrente — ${formatMoney(r.expectedAmount, r.currency ?? 'COP')}`,
          description: `Se creará un arriendo con cobro el día ${r.dueDay} de cada ciclo. No se envía ningún cobro.`,
          amount: r.expectedAmount,
        }
      }
    }
  }

  if (mode === 'choice') {
    return { title: 'Elegir una opción', description: summary || 'Necesitamos que indiques a cuál te refieres.' }
  }
  if (parsed?.kind === 'transcript') {
    return { title: 'Revisar transcripción de tu nota de voz', description: summary || 'Confirma lo que entendimos de tu nota.' }
  }
  return { title: summary ? short(summary, 60) : fallbackTitle, description: summary || fallbackTitle }
}
