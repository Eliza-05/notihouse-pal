import { api } from '../../lib/api/client'
import type { DashboardSummary } from '../../lib/api/types'

export function getDashboardSummary() {
  return api<DashboardSummary>('/dashboard/summary')
}
