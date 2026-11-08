import { useQuery } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import { getDashboardSummary } from './api'

export function useDashboardSummary() {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'dashboard'),
    queryFn: getDashboardSummary,
    staleTime: 30_000,
  })
}
