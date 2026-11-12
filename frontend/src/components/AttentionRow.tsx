import { CalendarClock, FileText, KeyRound, Receipt, UserCheck, type LucideIcon } from 'lucide-react'
import { StatusBadge } from './StatusBadge'
import { formatCalendarDate } from '../lib/format/dates'
import { formatMoney } from '../lib/format/money'
import { ATTENTION_CONDITION_LABELS, SUGGESTED_ACTION_LABELS, label } from '../lib/format/labels'
import type { AttentionCondition, AttentionItem, AttentionKind } from '../lib/api/types'
import type { ReviewHeading } from '../features/cases/reviewSummary'

const CONDITION_TONE: Record<AttentionCondition, 'danger' | 'warning' | 'neutral'> = {
  overdue: 'danger',
  due_today: 'warning',
  pending: 'warning',
  due_soon: 'warning',
  upcoming: 'neutral',
}

const KIND_ICON: Record<AttentionKind, LucideIcon> = {
  obligation_occurrence: Receipt,
  rent_charge: KeyRound,
  contract: FileText,
  hitl_request: UserCheck,
}

/** La descripción del backend ya trae el "vence en N días"; aquí solo la fecha. */
function whenLabel(item: AttentionItem) {
  return formatCalendarDate(item.relevantDate)
}

/**
 * Fila de la lista de vencimientos (diseño housepal_mvp): ícono por tipo,
 * título, descripción, pill de condición y monto. Toda la fila es un botón.
 */
export function AttentionRow({ item, onOpen, showAction = false, heading }: { item: AttentionItem; onOpen: (item: AttentionItem) => void; showAction?: boolean; heading?: ReviewHeading }) {
  const tone = CONDITION_TONE[item.condition]
  const Icon = item.condition === 'overdue' ? CalendarClock : KIND_ICON[item.kind]
  const unread = item.alert !== null && !item.alert.read
  // Revisiones: el título distinguible (proveedor + importe) reemplaza al genérico del servidor.
  const title = item.kind === 'hitl_request' && heading ? heading.title : item.title
  const amount = item.amount ?? (item.kind === 'hitl_request' ? (heading?.amount ?? null) : null)

  return (
    <button type="button" className="row-item" onClick={() => onOpen(item)}>
      <span className={`row-icon tone-bg-${tone === 'neutral' ? 'neutral' : tone}`}>
        <Icon size={17} aria-hidden="true" />
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="row-title" style={{ display: 'block' }}>
          {unread && <span className="visually-hidden">Sin leer: </span>}
          {title}
        </span>
        <span className="row-sub" style={{ display: 'block' }}>
          {item.description} · {whenLabel(item)}
        </span>
        {showAction && (
          <span className="row-sub" style={{ display: 'block', color: 'var(--accent)', fontWeight: 700 }}>
            {label(SUGGESTED_ACTION_LABELS, item.suggestedAction)} →
          </span>
        )}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 12, justifySelf: 'end' }}>
        <StatusBadge label={label(ATTENTION_CONDITION_LABELS, item.condition)} tone={tone} />
        {amount && <span className="row-amount">{formatMoney(amount, item.currency ?? 'COP')}</span>}
      </span>
    </button>
  )
}
