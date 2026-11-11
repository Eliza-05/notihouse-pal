import type { QueryClient } from '@tanstack/react-query'
import type { CaseStatus } from './types'

/**
 * Polling inteligente (solo GET al backend; nunca dispara Gemini ni n8n).
 * React Query pausa los intervalos con la pestaña oculta
 * (`refetchIntervalInBackground: false`) y revalida al recuperar el foco
 * cuando el dato está obsoleto (`staleTime: 0` en las consultas con polling).
 */
export const POLL_PROCESSING_MS = 5_000
export const POLL_AWAITING_MS = 10_000
export const POLL_LIST_MS = 15_000

const TERMINAL: ReadonlySet<string> = new Set<CaseStatus>(['completed', 'failed', 'cancelled'])

export function isTerminalCase(status: string | undefined): boolean {
  return !!status && TERMINAL.has(status)
}

/** Detalle de caso: rápido mientras se procesa; más lento esperando a la persona (para ver el cierre); nada si es terminal. */
export function caseInterval(status: string | undefined): number | false {
  if (!status) return false
  if (isTerminalCase(status)) return false
  return status === 'awaiting_human' ? POLL_AWAITING_MS : POLL_PROCESSING_MS
}

/**
 * Revisiones de un caso: mientras el caso no sea terminal y aún no exista una
 * revisión pendiente se consulta igual de rápido que el caso (así aparece
 * "Revisar" sin F5); con una pendiente se baja la frecuencia.
 */
export function caseHitlInterval(caseStatus: string | undefined, hasPending: boolean): number | false {
  if (!caseStatus || isTerminalCase(caseStatus)) return false
  return hasPending ? POLL_AWAITING_MS : POLL_PROCESSING_MS
}

/** Lista de casos: solo se consulta mientras algún caso visible siga en curso. */
export function caseListInterval(statuses: readonly string[] | undefined): number | false {
  if (!statuses || statuses.length === 0) return false
  return statuses.some((s) => !isTerminalCase(s)) ? POLL_LIST_MS : false
}

/**
 * Dominios cuyos datos cambian al decidir/aplicar una propuesta. Se invalidan
 * TODAS las claves del usuario de estas familias (lista y detalle), para que
 * "información general" y "períodos" muestren siempre lo mismo.
 */
const DOMAIN_KEYS: ReadonlySet<string> = new Set([
  'case', 'cases', 'proposals', 'hitl', 'hitl-detail',
  'obligations', 'obligation', 'occurrences',
  'rentals', 'rental', 'charges',
  'attention', 'dashboard', 'alerts',
])

export function invalidateAfterDecision(qc: QueryClient, userId: string): Promise<void> {
  return qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === userId && typeof q.queryKey[1] === 'string' && DOMAIN_KEYS.has(q.queryKey[1]),
  })
}
