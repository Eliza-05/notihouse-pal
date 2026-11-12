import type { HitlDetail } from '../../lib/api/types'
import type { ParsedProposal } from './proposalSchema'

/** Acciones de propuesta que el backend sabe aplicar (POST …/apply). */
export const APPLICABLE_ACTIONS: ReadonlySet<string> = new Set([
  'create_obligation_occurrence',
  'create_obligation_with_occurrence',
  'create_recurring_obligation',
  'update_obligation_schedule',
  'update_occurrence_details',
  'create_recurring_rental',
  'archive_obligation',
])

/**
 * - `applicable`: aprobar y luego aplicar crea/cambia datos.
 * - `choice`: hay alternativas; se registra la elección, nada se aplica solo.
 * - `informational`: no hay nada que autorizar ni aplicar; la persona solo toma nota.
 *
 * Ojo: "Entendido" sigue enviando la decisión `approved` (la misma transición
 * de servidor que antes; lo que cambia es la etiqueta y el texto que la rodea).
 */
export type ReviewMode = 'applicable' | 'choice' | 'informational'

export function reviewMode(hitl: Pick<HitlDetail, 'decisionType' | 'options' | 'proposal'>, parsed: ParsedProposal | null): ReviewMode {
  if ((hitl.options.choices ?? []).length > 0) return 'choice'
  if (
    hitl.decisionType === 'data_confirmation' &&
    hitl.proposal &&
    hitl.proposal.source !== 'stt' &&
    parsed?.kind === 'known' &&
    APPLICABLE_ACTIONS.has(parsed.value.action)
  ) {
    return 'applicable'
  }
  return 'informational'
}

export function canApplyProposal(hitl: HitlDetail, parsed: ParsedProposal | null): boolean {
  return (
    hitl.status === 'approved' &&
    !!hitl.proposal &&
    hitl.proposal.reviewStatus === 'accepted' &&
    reviewMode(hitl, parsed) === 'applicable'
  )
}

const FIELD_NAMES: Record<string, string> = {
  providerName: 'proveedor',
  concept: 'concepto',
  category: 'categoría',
  expectedAmount: 'monto esperado',
  amount: 'monto',
  dueDay: 'día de vencimiento',
  dueDate: 'fecha de vencimiento',
  reminderDaysBefore: 'días de aviso',
  periodStart: 'inicio del período',
  periodEnd: 'fin del período',
  startsOn: 'fecha de inicio',
  endsOn: 'fecha de fin',
  tenantAlias: 'inquilino',
  propertyId: 'inmueble',
  frequency: 'frecuencia',
  currency: 'moneda',
}

/** Reemplaza claves técnicas (`providerName`, `dueDay`…) por su nombre en español dentro de un texto. */
export function humanizeFieldKeys(text: string): string {
  return text.replace(/\b[a-z]+(?:[A-Z][a-z]+)+\b|\b(?:amount|concept|category|currency|frequency)\b/g, (k) => FIELD_NAMES[k] ?? k)
}
