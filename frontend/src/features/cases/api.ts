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

export function listCases(params: ListCasesParams = {}) {
  return api<Page<Case>>(`/cases${qs(params)}`)
}

export function getCase(id: string) {
  return api<Case>(`/cases/${id}`)
}

export function listProposals(caseId: string, params: ListProposalsParams = {}) {
  return api<Page<Proposal>>(`/cases/${caseId}/proposals${qs(params)}`)
}

export function applyProposal(caseId: string, proposalId: string) {
  return api<ProposalApplicationResponse>(`/cases/${caseId}/proposals/${proposalId}/apply`, { method: 'POST', body: {} })
}

export function listHitlRequests(params: ListHitlParams = {}) {
  return api<Page<HitlRequest>>(`/hitl-requests${qs(params)}`)
}

export function getHitlRequest(id: string) {
  return api<HitlDetail>(`/hitl-requests/${id}`)
}

export function decideHitl(id: string, input: DecideHitlInput) {
  return api<HitlDetail>(`/hitl-requests/${id}/decision`, { method: 'POST', body: input })
}
