import { CASE_TYPE_LABELS, label } from '../../lib/format/labels'
import type { Case, Proposal } from '../../lib/api/types'

/**
 * Título legible de una solicitud. Es SOLO presentación: no cambia `case.type`.
 *
 * El tipo de caso lo fija el backend al enviar el mensaje, antes de interpretarlo, así que todo texto o nota de voz
 * entra como «Obligación del hogar» aunque pida un arriendo. Una vez que existe propuesta, la acción propuesta dice
 * de qué trata de verdad.
 */
export function proposalAction(proposals: readonly Pick<Proposal, 'version' | 'proposedData'>[] | undefined): string | null {
  const latest = [...(proposals ?? [])].sort((a, b) => b.version - a.version)[0]
  const action = (latest?.proposedData as { action?: unknown } | null | undefined)?.action
  return typeof action === 'string' ? action : null
}

/** ¿Es una solicitud al asistente (texto/voz) cuyo tipo todavía no refleja lo pedido? */
export function isAssistantRequest(c: Pick<Case, 'type' | 'source'>): boolean {
  return c.type === 'household_obligation' && (c.source === 'form' || c.source === 'voice')
}

export function caseTitle(c: Pick<Case, 'type' | 'source'>, action: string | null): string {
  if (action === 'create_recurring_rental') return 'Registro de arriendo'
  if (action) return label(CASE_TYPE_LABELS, c.type) // acciones sobre obligaciones: el rótulo del tipo es correcto
  if (isAssistantRequest(c)) return 'Solicitud al asistente' // aún sin propuesta aplicable: etiqueta genérica
  return label(CASE_TYPE_LABELS, c.type)
}
