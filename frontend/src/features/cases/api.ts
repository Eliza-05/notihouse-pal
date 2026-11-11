import { api } from '../../lib/api/client'
import type {
  Case,
  DecideHitlInput,
  HitlDetail,
  HitlRequest,
  ListCasesParams,
  ListHitlParams,
  ListProposalsParams,
  Page,
  Proposal,
  ProposalApplicationResponse,
} from '../../lib/api/types'

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, string | number | boolean | undefined>).filter(
    ([, v]) => v !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export function listCases(params: ListCasesParams = {}, signal?: AbortSignal) {
  return api<Page<Case>>(`/cases${qs(params)}`, { signal })
}

export function getCase(id: string, signal?: AbortSignal) {
  return api<Case>(`/cases/${id}`, { signal })
}

export function listProposals(caseId: string, params: ListProposalsParams = {}, signal?: AbortSignal) {
  return api<Page<Proposal>>(`/cases/${caseId}/proposals${qs(params)}`, { signal })
}

export function applyProposal(caseId: string, proposalId: string) {
  return api<ProposalApplicationResponse>(`/cases/${caseId}/proposals/${proposalId}/apply`, { method: 'POST', body: {} })
}

export function listHitlRequests(params: ListHitlParams = {}, signal?: AbortSignal) {
  return api<Page<HitlRequest>>(`/hitl-requests${qs(params)}`, { signal })
}

export function getHitlRequest(id: string, signal?: AbortSignal) {
  return api<HitlDetail>(`/hitl-requests/${id}`, { signal })
}

export function decideHitl(id: string, input: DecideHitlInput) {
  return api<HitlDetail>(`/hitl-requests/${id}/decision`, { method: 'POST', body: input })
}
