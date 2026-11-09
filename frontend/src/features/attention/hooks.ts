import { useQuery } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import * as api from './api'
import type { ListAttentionParams } from '../../lib/api/types'

export function useAttention(params: ListAttentionParams = {}) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'attention', params),
    queryFn: () => api.listAttention(params),
  })
}
