import { api } from '../../lib/api/client'
import type { AttentionPage, ListAttentionParams } from '../../lib/api/types'

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, string | number | boolean | undefined>).filter(
    ([, v]) => v !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export function listAttention(params: ListAttentionParams = {}) {
  return api<AttentionPage>(`/attention${qs(params)}`)
}
