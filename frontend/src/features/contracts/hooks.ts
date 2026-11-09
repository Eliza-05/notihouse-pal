import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import * as api from './api'
import type { CreateContractInput, ListContractsParams, UpdateContractInput } from '../../lib/api/types'

export function useContracts(params: ListContractsParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'contracts', params),
    queryFn: () => api.listContracts(params),
  })
}

function invalidate(qc: ReturnType<typeof useQueryClient>, userId: string) {
  qc.invalidateQueries({ queryKey: queryKey(userId, 'contracts') })
  qc.invalidateQueries({ queryKey: queryKey(userId, 'attention') })
  qc.invalidateQueries({ queryKey: queryKey(userId, 'dashboard') })
}

export function useCreateContract() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateContractInput) => api.createContract(input),
    retry: false,
    onSuccess: () => invalidate(qc, user!.id),
  })
}

export function useUpdateContract() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateContractInput }) => api.updateContract(id, input),
    retry: false,
    onSuccess: () => invalidate(qc, user!.id),
  })
}
