import { api } from '../../lib/api/client'
import type { IngestionResponse } from '../../lib/api/types'

export function uploadVoice(file: Blob, fileName: string, requestId: string) {
  const form = new FormData()
  form.append('file', file, fileName)
  form.append('requestId', requestId)
  return api<IngestionResponse>('/ingestions/voice', { method: 'POST', body: form })
}
