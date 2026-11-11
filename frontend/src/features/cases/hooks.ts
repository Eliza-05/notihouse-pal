import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import { caseHitlInterval, caseInterval, caseListInterval, invalidateAfterDecision } from '../../lib/api/polling'
import * as api from './api'
import type { DecideHitlInput, ListCasesParams, ListHitlParams, ListProposalsParams } from '../../lib/api/types'

export function useCases(params: ListCasesParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'cases', params),
    queryFn: ({ signal }) => api.listCases(params, signal),
    staleTime: 0,
    refetchInterval: (query) => caseListInterval(query.state.data?.items.map((c) => c.status)),
    refetchIntervalInBackground: false,
  })
}

/** Consulta el caso con polling inteligente: 5 s en proceso, 10 s esperando decisión, nada en estado terminal. */
export function useCase(id: string | undefined) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'case', id),
    queryFn: ({ signal }) => api.getCase(id!, signal),
    enabled: !!id,
    staleTime: 0,
    refetchInterval: (query) => caseInterval(query.state.data?.status),
    refetchIntervalInBackground: false,
  })
}

export function useProposals(caseId: string | undefined, params: ListProposalsParams = {}) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'proposals', caseId, params),
    queryFn: ({ signal }) => api.listProposals(caseId!, params, signal),
    enabled: !!caseId,
    staleTime: 0,
  })
}

export function useApplyProposal() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ caseId, proposalId }: { caseId: string; proposalId: string }) => api.applyProposal(caseId, proposalId),
    retry: false,
    onSuccess: () => invalidateAfterDecision(qc, user!.id),
  })
}

export function useHitlRequests(params: ListHitlParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'hitl', params),
    queryFn: ({ signal }) => api.listHitlRequests(params, signal),
    staleTime: 0,
  })
}

/** Revisiones de un caso, sincronizadas con el estado del caso: "Revisar" aparece solo al pasar a `awaiting_human`. */
export function useCaseHitl(caseId: string | undefined, caseStatus: string | undefined) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'hitl', { caseId, pageSize: 10 }),
    queryFn: ({ signal }) => api.listHitlRequests({ caseId, pageSize: 10 }, signal),
    enabled: !!caseId,
    staleTime: 0,
    refetchInterval: (query) =>
      caseHitlInterval(caseStatus, !!query.state.data?.items.some((h) => h.status === 'pending')),
    refetchIntervalInBackground: false,
  })
}

export function useHitlRequest(id: string | undefined) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'hitl-detail', id),
    queryFn: ({ signal }) => api.getHitlRequest(id!, signal),
    enabled: !!id,
    staleTime: 0,
  })
}

export function useDecideHitl(id: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: DecideHitlInput) => api.decideHitl(id, input),
    retry: false,
    onSuccess: () => invalidateAfterDecision(qc, user!.id),
  })
}
