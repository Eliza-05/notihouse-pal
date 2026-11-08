import { api } from '../../lib/api/client'
import type {
  ConfirmChargeInput,
  CreateChargeInput,
  CreateRentalInput,
  ListChargesParams,
  ListRentalsParams,
  Page,
  Rental,
  RentCharge,
  UpdateChargeInput,
  UpdateRentalInput,
} from '../../lib/api/types'

function qs(params: object): string {
  const entries = Object.entries(params as Record<string, string | number | boolean | undefined>).filter(
    ([, v]) => v !== undefined,
  )
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export function listRentals(params: ListRentalsParams = {}) {
  return api<Page<Rental>>(`/rentals${qs(params)}`)
}

export function getRental(id: string) {
  return api<Rental>(`/rentals/${id}`)
}

export function createRental(input: CreateRentalInput) {
  return api<Rental>('/rentals', { method: 'POST', body: input })
}

export function updateRental(id: string, input: UpdateRentalInput) {
  return api<Rental>(`/rentals/${id}`, { method: 'PATCH', body: input })
}

export function listCharges(rentalId: string, params: ListChargesParams = {}) {
  return api<Page<RentCharge>>(`/rentals/${rentalId}/charges${qs({ pageSize: 50, ...params })}`)
}

export function createCharge(rentalId: string, input: CreateChargeInput) {
  return api<RentCharge>(`/rentals/${rentalId}/charges`, { method: 'POST', body: input })
}

export function updateCharge(rentalId: string, chargeId: string, input: UpdateChargeInput) {
  return api<RentCharge>(`/rentals/${rentalId}/charges/${chargeId}`, { method: 'PATCH', body: input })
}

export function confirmCharge(rentalId: string, chargeId: string, input: ConfirmChargeInput) {
  return api<RentCharge>(`/rentals/${rentalId}/charges/${chargeId}/confirm`, { method: 'POST', body: input })
}
