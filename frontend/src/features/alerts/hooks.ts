import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import { ApiError } from '../../lib/api/errors'
import * as api from './api'
import type { ListAlertsParams } from '../../lib/api/types'

function invalidateAfterMutation(qc: ReturnType<typeof useQueryClient>, userId: string) {
  qc.invalidateQueries({ queryKey: queryKey(userId, 'alerts') })
  qc.invalidateQueries({ queryKey: queryKey(userId, 'attention') })
  qc.invalidateQueries({ queryKey: queryKey(userId, 'dashboard') })
}

/**
 * Contador de la campana (§8.7, §11.10): refresco de baja frecuencia (≥60s),
 * solo con la pestaña visible y sesión vigente; `GET /alerts/summary` puede
 * responder 404 si Render es anterior a la Etapa 7 (aquí: API local ya la
 * tiene) — en ese caso el llamador cae a `dashboard.alerts.unread`.
 */
export function useAlertSummary() {
  const { user, isAuthenticated } = useAuth()
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  return useQuery({
    queryKey: queryKey(user?.id ?? '', 'alerts', 'summary'),
    queryFn: api.getAlertSummary,
    enabled: isAuthenticated && visible,
    refetchInterval: visible ? 60_000 : false,
    refetchIntervalInBackground: false,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 1,
  })
}

export function useSystemStatus() {
  const { user, isAuthenticated } = useAuth()
  return useQuery({
    queryKey: queryKey(user?.id ?? '', 'system-status'),
    queryFn: api.getSystemStatus,
    enabled: isAuthenticated,
    staleTime: 60_000,
    retry: false,
  })
}

export function useAlerts(params: ListAlertsParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'alerts', params),
    queryFn: () => api.listAlerts(params),
  })
}

export function useAlert(id: string) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'alert', id),
    queryFn: () => api.getAlert(id),
    enabled: !!id,
  })
}

export function useMarkAlertRead() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.markAlertRead,
    retry: false,
    onSuccess: () => invalidateAfterMutation(qc, user!.id),
  })
}

export function useDismissAlert() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.dismissAlert,
    retry: false,
    onSuccess: () => invalidateAfterMutation(qc, user!.id),
  })
}
