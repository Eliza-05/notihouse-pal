import { api } from '../../lib/api/client'
import type { CreatePropertyInput, ListPropertiesParams, Page, Property, UpdatePropertyInput } from '../../lib/api/types'

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, string | number | boolean | undefined>).filter(
    ([, v]) => v !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export function listProperties(params: ListPropertiesParams = {}) {
  return api<Page<Property>>(`/properties${qs(params)}`)
}

export function getProperty(id: string) {
  return api<Property>(`/properties/${id}`)
}

export function createProperty(input: CreatePropertyInput) {
  return api<Property>('/properties', { method: 'POST', body: input })
}

export function updateProperty(id: string, input: UpdatePropertyInput) {
  return api<Property>(`/properties/${id}`, { method: 'PATCH', body: input })
}
