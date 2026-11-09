import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import * as api from './api'
import type {
  ConfirmChargeInput,
  CreateChargeInput,
  CreateRentalInput,
  ListChargesParams,
  ListRentalsParams,
  UpdateChargeInput,
  UpdateRentalInput,
} from '../../lib/api/types'

export function useRentals(params: ListRentalsParams) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'rentals', params),
    queryFn: () => api.listRentals(params),
  })
}

export function useRental(id: string | undefined) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'rental', id),
    queryFn: () => api.getRental(id!),
    enabled: !!id,
  })
}

function invalidateRentals(qc: ReturnType<typeof useQueryClient>, userId: string, id?: string) {
  qc.invalidateQueries({ queryKey: queryKey(userId, 'rentals') })
  if (id) {
    qc.invalidateQueries({ queryKey: queryKey(userId, 'rental', id) })
    qc.invalidateQueries({ queryKey: queryKey(userId, 'charges', id) })
  }
  qc.invalidateQueries({ queryKey: queryKey(userId, 'attention') })
  qc.invalidateQueries({ queryKey: queryKey(userId, 'dashboard') })
}

export function useCreateRental() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateRentalInput) => api.createRental(input),
    retry: false,
    onSuccess: () => invalidateRentals(qc, user!.id),
  })
}

export function useUpdateRental() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRentalInput }) => api.updateRental(id, input),
    retry: false,
    onSuccess: (_d, { id }) => invalidateRentals(qc, user!.id, id),
  })
}

export function useCharges(rentalId: string | undefined, params: ListChargesParams = {}) {
  const { user } = useAuth()
  return useQuery({
    queryKey: queryKey(user!.id, 'charges', rentalId, params),
    queryFn: () => api.listCharges(rentalId!, params),
    enabled: !!rentalId,
  })
}

export function useCreateCharge(rentalId: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateChargeInput) => api.createCharge(rentalId, input),
    retry: false,
    onSuccess: () => invalidateRentals(qc, user!.id, rentalId),
  })
}

export function useUpdateCharge(rentalId: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ chargeId, input }: { chargeId: string; input: UpdateChargeInput }) =>
      api.updateCharge(rentalId, chargeId, input),
    retry: false,
    onSuccess: () => invalidateRentals(qc, user!.id, rentalId),
  })
}

export function useConfirmCharge(rentalId: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ chargeId, input }: { chargeId: string; input: ConfirmChargeInput }) =>
      api.confirmCharge(rentalId, chargeId, input),
    retry: false,
    onSuccess: () => invalidateRentals(qc, user!.id, rentalId),
  })
}
