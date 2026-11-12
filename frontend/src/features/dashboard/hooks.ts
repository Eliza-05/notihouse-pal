import { useQuery } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import { POLL_LIST_MS } from '../../lib/api/polling'
import { getDashboardSummary } from './api'

export function useDashboardSummary() {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'dashboard'),
    queryFn: getDashboardSummary,
    staleTime: 0,
    refetchInterval: POLL_LIST_MS * 2,
    refetchIntervalInBackground: false,
  })
}
