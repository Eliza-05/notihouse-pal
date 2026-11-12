// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ handler: (_path: string): unknown => undefined }))
vi.mock('../../lib/api/client', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/client')>()),
  api: (path: string) => Promise.resolve().then(() => state.handler(path)),
}))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'camila' }, isAuthenticated: true }) }))

import { ToastProvider } from '../../components/Toasts'
import { CaseDetailPage } from './CaseDetailPage'
import { CasesPage } from './CasesPage'

const rentalProposal = { id: 'p1', caseId: 'c1', version: 1, source: 'llm', proposedData: { action: 'create_recurring_rental', data: { rental: { propertyId: 'x', expectedAmount: '1200000.00', dueDay: 5, startsOn: '2026-12-01' } } }, documentId: null, reviewStatus: 'pending_review', createdAt: 't', updatedAt: 't' }
const mk = (id: string, status: string, source = 'form') => ({ id, correlationId: 'k', type: 'household_obligation', source, status, obligationId: null, rentalId: null, contractId: null, statusReason: null, closedAt: null, createdAt: '2026-11-11T23:13:00Z', updatedAt: '2026-11-11T23:13:00Z' })

function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/casos" element={<CasesPage />} />
            <Route path="/casos/:id" element={<CaseDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(30) }) }

beforeEach(() => {
  vi.useFakeTimers()
  state.handler = (path) => {
    if (path.startsWith('/cases/c1/proposals')) return { items: [rentalProposal], total: 1, page: 1, pageSize: 20 }
    if (path.startsWith('/cases/c2/proposals')) return { items: [], total: 0, page: 1, pageSize: 20 }
    if (path === '/cases/c1') return mk('c1', 'awaiting_human')
    if (path.startsWith('/cases?')) return { items: [mk('c1', 'awaiting_human'), mk('c2', 'processing'), mk('c3', 'completed', 'document')], total: 3, page: 1, pageSize: 20 }
    if (path.startsWith('/hitl-requests')) return { items: [], total: 0, page: 1, pageSize: 10 }
  }
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('título de la solicitud: Mis solicitudes y detalle coinciden', () => {
  it('detalle: una propuesta de arriendo muestra «Registro de arriendo»', async () => {
    mount('/casos/c1')
    await settle()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Registro de arriendo')
    expect(document.body.textContent).not.toMatch(/Obligación del hogar/)
  })

  it('lista: el mismo caso dice «Registro de arriendo»; sin propuesta, genérico; documentos, sin cambio', async () => {
    mount('/casos')
    await settle()
    const cells = screen.getAllByRole('row').slice(1).map((r) => r.querySelector('td')!.textContent)
    expect(cells).toEqual(['Registro de arriendo', 'Solicitud al asistente', 'Obligación del hogar'])
  })
})
