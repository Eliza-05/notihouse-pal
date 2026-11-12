// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, RequestTimeoutError } from '../../lib/api/errors'

const state = vi.hoisted(() => ({
  handler: (_path: string, _opts?: { body?: unknown; method?: string }): unknown => undefined,
}))
vi.mock('../../lib/api/client', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/client')>()),
  api: (path: string, o?: { body?: unknown; method?: string }) => Promise.resolve().then(() => state.handler(path, o)),
}))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'camila' }, isAuthenticated: true }) }))

import { ToastProvider, ToastViewport } from '../../components/Toasts'
import { ObligationDetailPage } from './ObligationDetailPage'

let obligation: Record<string, unknown>
let occurrences: Array<Record<string, unknown>>
let archiveCalls = 0
let archiveBehavior: 'ok' | 'conflict' | 'timeout_but_archived' | 'timeout_not_archived' | 'server_error' = 'ok'
let release: (() => void) | null = null

const base = {
  id: 'o1', propertyId: null, providerName: 'Internet Hogar de Prueba', concept: 'Servicio de internet', category: 'internet',
  expectedAmount: '75000.00', currency: 'COP', frequency: 'monthly', dueDay: 10, reminderDaysBefore: 3, startsOn: null,
  status: 'active', autoGenerate: true, createdAt: 't', updatedAt: 't',
}
const occ = (id: string, status: string) => ({
  id, obligationId: 'o1', periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-11-10', amount: '75000.00', currency: 'COP', status,
})

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/obligaciones/o1']}>
          <ToastViewport />
          <Routes>
            <Route path="/obligaciones/:id" element={<ObligationDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}
const open = async () => {
  mount()
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Archivar obligación' }))
  await settle()
}
const confirmButton = () => screen.getAllByRole('button', { name: /Archivar obligación|Archivando/ }).at(-1)!

beforeEach(() => {
  vi.useFakeTimers()
  obligation = { ...base }
  occurrences = [occ('p1', 'pending'), occ('p2', 'paid')]
  archiveCalls = 0
  archiveBehavior = 'ok'
  release = null
  state.handler = (path, opts) => {
    if (path === '/obligations/o1/archive' && opts?.method === 'POST') {
      archiveCalls++
      if (archiveBehavior === 'conflict') throw new ApiError(409, ['Esta obligación ya estaba archivada'])
      if (archiveBehavior === 'server_error') throw new ApiError(500, ['boom'])
      if (archiveBehavior === 'timeout_but_archived') {
        obligation = { ...obligation, status: 'archived' }
        throw new RequestTimeoutError(true)
      }
      if (archiveBehavior === 'timeout_not_archived') throw new RequestTimeoutError(true)
      return new Promise((resolve) => {
        release = () => {
          obligation = { ...obligation, status: 'archived' }
          resolve({ ...obligation, pendingOccurrences: 1 })
        }
      })
    }
    if (path === '/obligations/o1') return obligation
    if (path.startsWith('/obligations/o1/occurrences')) return { items: occurrences, page: 1, pageSize: 50, total: occurrences.length }
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('archivado manual de una obligación', () => {
  it('pide confirmación, explica las consecuencias y avisa de los períodos pendientes; Cancelar no archiva', async () => {
    await open()
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/¿Quieres archivar esta obligación\?/)
    expect(dialog.textContent).toMatch(/no generará nuevos períodos automáticamente/)
    expect(dialog.textContent).toMatch(/Conservaremos su historial/)
    expect(dialog.textContent).toMatch(/1 período pendiente o vencido/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(archiveCalls).toBe(0)
  })

  it('doble clic: una sola petición, spinner en el botón y el estado se actualiza al terminar', async () => {
    await open()
    fireEvent.click(confirmButton())
    fireEvent.click(confirmButton())
    await settle()
    expect(archiveCalls).toBe(1)
    expect(confirmButton().getAttribute('aria-busy')).toBe('true')
    await act(async () => { release!() })
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByText('Archivada').length).toBeGreaterThan(0)
    expect(screen.getByText(/Esta obligación está archivada/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Archivar obligación' })).toBeNull()
    expect(document.body.textContent).toMatch(/Obligación archivada correctamente/)
  })

  it('409 (ya estaba archivada): mensaje informativo, no un error', async () => {
    archiveBehavior = 'conflict'
    await open()
    fireEvent.click(confirmButton())
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toMatch(/ya estaba archivada/)
  })

  it('tiempo agotado: consulta el estado real; si ya se archivó lo confirma sin pedir reintentar', async () => {
    archiveBehavior = 'timeout_but_archived'
    await open()
    fireEvent.click(confirmButton())
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toMatch(/Obligación archivada correctamente/)
    expect(archiveCalls).toBe(1)
  })

  it('tiempo agotado y sigue activa: lo dice y permite volver a intentar', async () => {
    archiveBehavior = 'timeout_not_archived'
    await open()
    fireEvent.click(confirmButton())
    await settle()
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/sigue activa/)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('error del servidor: mensaje claro sin detalles técnicos y el botón se restablece', async () => {
    archiveBehavior = 'server_error'
    await open()
    fireEvent.click(confirmButton())
    await settle()
    const text = screen.getAllByRole('alert').map((a) => a.textContent).join(' ')
    expect(text).toMatch(/No pudimos archivar la obligación/)
    expect(text).not.toMatch(/boom|500/)
    expect(confirmButton().hasAttribute('disabled')).toBe(false)
  })

  it('una obligación ya archivada no ofrece la acción', async () => {
    obligation = { ...base, status: 'archived' }
    mount()
    await settle()
    expect(screen.queryByRole('button', { name: 'Archivar obligación' })).toBeNull()
    expect(screen.getByText(/Esta obligación está archivada/)).toBeTruthy()
    expect(screen.getByText(/1 período sin resolver que sigue visible/)).toBeTruthy()
  })
})
