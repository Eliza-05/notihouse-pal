import { api } from '../../lib/api/client'
import { getToken } from '../../lib/auth/session'
import { ApiError } from '../../lib/api/errors'
import { logout } from '../../lib/auth/session'
import type { DocumentMeta, IngestionResponse, ListDocumentsParams, Page } from '../../lib/api/types'

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, string | number | boolean | undefined>).filter(
    ([, v]) => v !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export function listDocuments(params: ListDocumentsParams = {}) {
  return api<Page<DocumentMeta>>(`/documents${qs(params)}`)
}

export function getDocument(id: string) {
  return api<DocumentMeta>(`/documents/${id}`)
}

export function uploadDocument(file: File, requestId: string, obligationId?: string) {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('documentType', 'invoice')
  form.append('requestId', requestId)
  if (obligationId) form.append('obligationId', obligationId)
  return api<IngestionResponse>('/ingestions/documents', { method: 'POST', body: form })
}

/**
 * Descarga autenticada (§11.7): `GET /documents/:id/content` exige JWT, así
 * que no sirve un `<a href>` directo. Se descarga con fetch + Blob y se
 * revoca la URL después (no de inmediato: algunos navegadores aún no
 * iniciaron la descarga).
 */
export async function downloadDocument(id: string, fileName: string): Promise<void> {
  const base = import.meta.env.VITE_API_BASE_URL
  const res = await fetch(`${base}/documents/${id}/content`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (res.status === 401) {
    logout()
    throw new ApiError(401, ['Sesión vencida'])
  }
  if (!res.ok) throw await ApiError.from(res)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
