import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import * as api from './api'
import type {
  ConfirmOccurrenceInput,
  CreateObligationInput,
  CreateOccurrenceInput,
  ListObligationsParams,
  OccurrenceStatus,
  UpdateObligationInput,
  UpdateOccurrenceInput,
} from '../../lib/api/types'

export function useObligations(params: ListObligationsParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'obligations', params),
    queryFn: () => api.listObligations(params),
  })
}

export function useObligation(id: string | undefined) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'obligation', id),
    queryFn: () => api.getObligation(id!),
    enabled: !!id,
  })
}

function invalidateObligations(qc: ReturnType<typeof useQueryClient>, userId: string, id?: string) {
  qc.invalidateQueries({ queryKey: queryKey(userId, 'obligations') })
  if (id) {
    qc.invalidateQueries({ queryKey: queryKey(userId, 'obligation', id) })
    qc.invalidateQueries({ queryKey: queryKey(userId, 'occurrences', id) })
  }
  qc.invalidateQueries({ queryKey: queryKey(userId, 'attention') })
  qc.invalidateQueries({ queryKey: queryKey(userId, 'dashboard') })
}

export function useCreateObligation() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateObligationInput) => api.createObligation(input),
    retry: false,
    onSuccess: () => invalidateObligations(qc, user!.id),
  })
}

export function useUpdateObligation() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateObligationInput }) => api.updateObligation(id, input),
    retry: false,
    onSuccess: (_d, { id }) => invalidateObligations(qc, user!.id, id),
  })
}

export function useOccurrences(obligationId: string | undefined, status?: OccurrenceStatus) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'occurrences', obligationId, status),
    queryFn: () => api.listOccurrences(obligationId!, status),
    enabled: !!obligationId,
  })
}

export function useCreateOccurrence(obligationId: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateOccurrenceInput) => api.createOccurrence(obligationId, input),
    retry: false,
    onSuccess: () => invalidateObligations(qc, user!.id, obligationId),
  })
}

export function useUpdateOccurrence(obligationId: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ occurrenceId, input }: { occurrenceId: string; input: UpdateOccurrenceInput }) =>
      api.updateOccurrence(obligationId, occurrenceId, input),
    retry: false,
    onSuccess: () => invalidateObligations(qc, user!.id, obligationId),
  })
}

export function useConfirmOccurrence(obligationId: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ occurrenceId, input }: { occurrenceId: string; input: ConfirmOccurrenceInput }) =>
      api.confirmOccurrence(obligationId, occurrenceId, input),
    retry: false,
    onSuccess: () => invalidateObligations(qc, user!.id, obligationId),
  })
}
