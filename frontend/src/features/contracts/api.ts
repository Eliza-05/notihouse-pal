import { api } from '../../lib/api/client'
import type { Contract, CreateContractInput, ListContractsParams, Page, UpdateContractInput } from '../../lib/api/types'

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, string | number | boolean | undefined>).filter(
    ([, v]) => v !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export function listContracts(params: ListContractsParams = {}) {
  return api<Page<Contract>>(`/contracts${qs(params)}`)
}

export function getContract(id: string) {
  return api<Contract>(`/contracts/${id}`)
}

export function createContract(input: CreateContractInput) {
  return api<Contract>('/contracts', { method: 'POST', body: input })
}

export function updateContract(id: string, input: UpdateContractInput) {
  return api<Contract>(`/contracts/${id}`, { method: 'PATCH', body: input })
}
