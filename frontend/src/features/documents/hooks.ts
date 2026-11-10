import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import * as api from './api'
import type { ListDocumentsParams } from '../../lib/api/types'

export function useDocuments(params: ListDocumentsParams = {}) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'documents', params),
    queryFn: () => api.listDocuments(params),
  })
}

export function useUploadDocument() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, requestId, obligationId }: { file: File; requestId: string; obligationId?: string }) =>
      api.uploadDocument(file, requestId, obligationId),
    retry: false,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'documents') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'cases') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'dashboard') })
    },
  })
}
