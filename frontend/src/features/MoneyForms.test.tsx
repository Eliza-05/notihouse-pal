// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  createObligation: vi.fn(),
  updateObligation: vi.fn(),
  createOccurrence: vi.fn(),
  updateOccurrence: vi.fn(),
  createRental: vi.fn(),
  updateRental: vi.fn(),
  createCharge: vi.fn(),
  updateCharge: vi.fn(),
}))
const mut = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, isPending: false })

vi.mock('./obligations/hooks', () => ({
  useCreateObligation: () => mut(m.createObligation),
  useUpdateObligation: () => mut(m.updateObligation),
  useCreateOccurrence: () => mut(m.createOccurrence),
  useUpdateOccurrence: () => mut(m.updateOccurrence),
}))
vi.mock('./rentals/hooks', () => ({
  useCreateRental: () => mut(m.createRental),
  useUpdateRental: () => mut(m.updateRental),
  useCreateCharge: () => mut(m.createCharge),
  useUpdateCharge: () => mut(m.updateCharge),
}))
vi.mock('./properties/hooks', () => ({
  useProperties: () => ({ data: { items: [{ id: 'p1', name: 'Apto 1' }] } }),
}))

import { ObligationFormModal } from './obligations/ObligationFormModal'
import { OccurrenceFormModal } from './obligations/OccurrenceFormModal'
import { ChargeFormModal } from './rentals/ChargeFormModal'
import { RentalFormModal } from './rentals/RentalFormModal'

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)
const noop = () => {}
const field = (id: string) => document.getElementById(id) as HTMLInputElement
const submit = () => fireEvent.click(screen.getByRole('button', { name: /guardar|crear|registrar|agregar/i }))
async function type(id: string, text: string) {
  const user = userEvent.setup()
  await user.clear(field(id))
  await user.type(field(id), text)
}
const dates = (ids: Record<string, string>) => {
  for (const [id, v] of Object.entries(ids)) fireEvent.change(field(id), { target: { value: v } })
}

describe('Obligación (crear/editar)', () => {
  async function fill(amount: string) {
    await type('providerName', 'Claro')
    await type('concept', 'internet')
    if (amount) await type('expectedAmount', amount)
  }
  it('Claro: 55000 se muestra 55.000 y se envía 55000.00 (sin exigir decimales)', async () => {
    m.createObligation.mockResolvedValue({})
    render(<ObligationFormModal onClose={noop} />)
    await fill('55000')
    expect(field('expectedAmount').value).toBe('55.000')
    submit()
    await waitFor(() => expect(m.createObligation).toHaveBeenCalled())
    expect(m.createObligation.mock.calls[0][0].expectedAmount).toBe('55000.00')
  })
  it('acueducto con decimales: 43200,5 → 43200.50', async () => {
    m.createObligation.mockResolvedValue({})
    render(<ObligationFormModal onClose={noop} />)
    await fill('43200,5')
    submit()
    await waitFor(() => expect(m.createObligation).toHaveBeenCalled())
    expect(m.createObligation.mock.calls[0][0].expectedAmount).toBe('43200.50')
  })
  it('monto vacío no se convierte en cero: no se envía', async () => {
    m.createObligation.mockResolvedValue({})
    render(<ObligationFormModal onClose={noop} />)
    await fill('')
    submit()
    await waitFor(() => expect(m.createObligation).toHaveBeenCalled())
    expect(m.createObligation.mock.calls[0][0].expectedAmount).toBeUndefined()
  })
  it('más de dos decimales: error en español y no se envía', async () => {
    render(<ObligationFormModal onClose={noop} />)
    await fill('55000,123')
    submit()
    expect(await screen.findByText('Usa máximo 2 decimales, p. ej. 55.000,50')).toBeTruthy()
    expect(m.createObligation).not.toHaveBeenCalled()
  })
  it('edición: muestra el monto existente formateado y conserva el valor', async () => {
    m.updateObligation.mockResolvedValue({})
    const obligation = {
      id: 'o1', propertyId: null, providerName: 'Energía Solar', concept: 'energía', category: 'electricity', expectedAmount: '151300.00',
      currency: 'COP', frequency: 'monthly', dueDay: 10, reminderDaysBefore: 3, startsOn: null, status: 'active', autoGenerate: false, createdAt: '', updatedAt: '',
    }
    render(<ObligationFormModal obligation={obligation as never} onClose={noop} />)
    expect(field('expectedAmount').value).toBe('151.300')
    submit()
    await waitFor(() => expect(m.updateObligation).toHaveBeenCalled())
    expect(m.updateObligation.mock.calls[0][0].input.expectedAmount).toBe('151300.00')
  })
})

describe('Período de obligación', () => {
  it('Acueducto: 43200 → 43200.00 y vacío → no se envía', async () => {
    m.createOccurrence.mockResolvedValue({})
    render(<OccurrenceFormModal obligationId="o1" onClose={noop} />)
    dates({ periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-05' })
    await type('amount', '43200')
    expect(field('amount').value).toBe('43.200')
    submit()
    await waitFor(() => expect(m.createOccurrence).toHaveBeenCalled())
    expect(m.createOccurrence.mock.calls[0][0].amount).toBe('43200.00')
  })
})

describe('Arriendo y cobros', () => {
  it('Arriendo: 1200000 → 1.200.000 → 1200000.00', async () => {
    m.createRental.mockResolvedValue({})
    render(<RentalFormModal onClose={noop} />)
    fireEvent.change(field('propertyId'), { target: { value: 'p1' } })
    await type('expectedAmount', '1200000')
    expect(field('expectedAmount').value).toBe('1.200.000')
    fireEvent.change(field('dueDay'), { target: { value: '5' } })
    dates({ startsOn: '2026-12-01' })
    submit()
    await waitFor(() => expect(m.createRental).toHaveBeenCalled())
    expect(m.createRental.mock.calls[0][0].expectedAmount).toBe('1200000.00')
  })
  it('Arriendo: el canon es obligatorio y no admite cero', async () => {
    render(<RentalFormModal onClose={noop} />)
    fireEvent.change(field('propertyId'), { target: { value: 'p1' } })
    fireEvent.change(field('dueDay'), { target: { value: '5' } })
    dates({ startsOn: '2026-12-01' })
    submit()
    expect(await screen.findByText('Ingresa el monto')).toBeTruthy()
    await type('expectedAmount', '0')
    submit()
    expect(await screen.findByText('Debe ser mayor que cero')).toBeTruthy()
    expect(m.createRental).not.toHaveBeenCalled()
  })
  it('Cobro: monto opcional; 1200000,5 → 1200000.50', async () => {
    m.createCharge.mockResolvedValue({})
    render(<ChargeFormModal rentalId="r1" onClose={noop} />)
    dates({ periodStart: '2026-12-01', periodEnd: '2026-12-31', dueDate: '2026-12-05' })
    await type('expectedAmount', '1200000,5')
    expect(field('expectedAmount').value).toBe('1.200.000,5')
    submit()
    await waitFor(() => expect(m.createCharge).toHaveBeenCalled())
    expect(m.createCharge.mock.calls[0][0].expectedAmount).toBe('1200000.50')
  })
})
