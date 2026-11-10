import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import * as api from './api'
import type { CreatePropertyInput, ListPropertiesParams, UpdatePropertyInput } from '../../lib/api/types'

export function useProperties(params: ListPropertiesParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'properties', params),
    queryFn: () => api.listProperties(params),
  })
}

export function useProperty(id: string | undefined) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'property', id),
    queryFn: () => api.getProperty(id!),
    enabled: !!id,
  })
}

export function useCreateProperty() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreatePropertyInput) => api.createProperty(input),
    retry: false,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(user!.id, 'properties') }),
  })
}

export function useUpdateProperty() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePropertyInput }) => api.updateProperty(id, input),
    retry: false,
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'properties') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'property', id) })
    },
  })
}
