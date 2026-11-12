import { api } from '../../lib/api/client'
import type {
  ArchivedObligation,
  ConfirmOccurrenceInput,
  CreateObligationInput,
  CreateOccurrenceInput,
  ListObligationsParams,
  Obligation,
  ObligationOccurrence,
  OccurrenceStatus,
  Page,
  UpdateObligationInput,
  UpdateOccurrenceInput,
} from '../../lib/api/types'

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, string | number | boolean | undefined>).filter(
    ([, v]) => v !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export function listObligations(params: ListObligationsParams = {}) {
  return api<Page<Obligation>>(`/obligations${qs(params)}`)
}

export function getObligation(id: string) {
  return api<Obligation>(`/obligations/${id}`)
}

export function createObligation(input: CreateObligationInput) {
  return api<Obligation>('/obligations', { method: 'POST', body: input })
}

export function updateObligation(id: string, input: UpdateObligationInput) {
  return api<Obligation>(`/obligations/${id}`, { method: 'PATCH', body: input })
}

/** Archivado manual: nunca borra; conserva períodos, documentos e historial. */
export function archiveObligation(id: string) {
  return api<ArchivedObligation>(`/obligations/${id}/archive`, { method: 'POST' })
}

export function listOccurrences(obligationId: string, status?: OccurrenceStatus, page = 1, pageSize = 50) {
  return api<Page<ObligationOccurrence>>(`/obligations/${obligationId}/occurrences${qs({ status, page, pageSize })}`)
}

export function createOccurrence(obligationId: string, input: CreateOccurrenceInput) {
  return api<ObligationOccurrence>(`/obligations/${obligationId}/occurrences`, { method: 'POST', body: input })
}

export function updateOccurrence(obligationId: string, occurrenceId: string, input: UpdateOccurrenceInput) {
  return api<ObligationOccurrence>(`/obligations/${obligationId}/occurrences/${occurrenceId}`, {
    method: 'PATCH',
    body: input,
  })
}

export function confirmOccurrence(obligationId: string, occurrenceId: string, input: ConfirmOccurrenceInput) {
  return api<ObligationOccurrence>(`/obligations/${obligationId}/occurrences/${occurrenceId}/confirm`, {
    method: 'POST',
    body: input,
  })
}
