import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import * as api from './api'
import type { DecideHitlInput, ListCasesParams, ListHitlParams, ListProposalsParams } from '../../lib/api/types'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export function useCases(params: ListCasesParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'cases', params),
    queryFn: () => api.listCases(params),
  })
}

/** Consulta el caso con intervalos espaciados (§11.10): se detiene en estado terminal o `awaiting_human`. */
export function useCase(id: string | undefined) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'case', id),
    queryFn: () => api.getCase(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      if (!status || TERMINAL.has(status) || status === 'awaiting_human') return false
      return 5_000
    },
    refetchIntervalInBackground: false,
  })
}

export function useProposals(caseId: string | undefined, params: ListProposalsParams = {}) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'proposals', caseId, params),
    queryFn: () => api.listProposals(caseId!, params),
    enabled: !!caseId,
  })
}

export function useApplyProposal() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ caseId, proposalId }: { caseId: string; proposalId: string }) => api.applyProposal(caseId, proposalId),
    retry: false,
    onSuccess: (_d, { caseId }) => {
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'case', caseId) })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'proposals', caseId) })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'obligations') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'rentals') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'attention') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'dashboard') })
    },
  })
}

export function useHitlRequests(params: ListHitlParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'hitl', params),
    queryFn: () => api.listHitlRequests(params),
  })
}

export function useHitlRequest(id: string | undefined) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'hitl-detail', id),
    queryFn: () => api.getHitlRequest(id!),
    enabled: !!id,
  })
}

export function useDecideHitl(id: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: DecideHitlInput) => api.decideHitl(id, input),
    retry: false,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'hitl') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'hitl-detail', id) })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'cases') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'attention') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'dashboard') })
    },
  })
}
