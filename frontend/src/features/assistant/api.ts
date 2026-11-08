import { api } from '../../lib/api/client'
import type { CreateTextIngestionInput, TextIngestionResponse } from '../../lib/api/types'

export function sendTextIngestion(input: CreateTextIngestionInput) {
  return api<TextIngestionResponse>('/ingestions/text', { method: 'POST', body: input })
}
