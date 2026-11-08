import { api } from '../../lib/api/client'
import type { Alert, AlertSummary, ListAlertsParams, Page, SystemStatus } from '../../lib/api/types'

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, string | number | boolean | undefined>).filter(
    ([, v]) => v !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export function listAlerts(params: ListAlertsParams = {}) {
  return api<Page<Alert>>(`/alerts${qs(params)}`)
}

export function getAlert(id: string) {
  return api<Alert>(`/alerts/${id}`)
}

/** L1 (Etapa 7): contador ligero de la campana. 404 si Render es anterior. */
export function getAlertSummary() {
  return api<AlertSummary>('/alerts/summary')
}

export function getSystemStatus() {
  return api<SystemStatus>('/system/status')
}

export function markAlertRead(id: string) {
  return api<Alert>(`/alerts/${id}/read`, { method: 'POST' })
}

export function dismissAlert(id: string) {
  return api<Alert>(`/alerts/${id}/dismiss`, { method: 'POST' })
}
