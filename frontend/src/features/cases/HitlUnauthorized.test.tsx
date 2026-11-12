// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api/errors'

/**
 * Un 401 en una aprobación o aplicación HITL. La interfaz NO debe:
 * - reintentar sola (una mutación se envía una vez por acción de la persona),
 * - mostrar éxito,
 * - afirmar que «no se registró nada»: el 401 prueba que el guard rechazó ESA petición
 *   (el backend verifica el JWT antes de entrar al controlador; ver
 *   backend/test/proposal-application.e2e-spec.ts, «authentication failures on HITL operations»), pero el estado real siempre se
 *   vuelve a leer del servidor al reabrir la revisión (la caché se limpia al cerrar sesión).
 */
const state = vi.hoisted(() => ({
  handler: (_path: string, _opts?: { body?: unknown; method?: string }): unknown => undefined,
}))
vi.mock('../../lib/api/client', () => ({
  api: (path: string, o?: { body?: unknown; method?: string }) => Promise.resolve().then(() => state.handler(path, o)),
}))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'camila' }, isAuthenticated: true }) }))

import { ToastProvider, ToastViewport } from '../../components/Toasts'
import { HitlDetailPage } from './HitlDetailPage'

const aseo = {
  action: 'create_obligation_with_occurrence',
  data: {
    obligation: { providerName: 'Aseo Verde de Prueba S.A.S.', concept: 'Servicio de aseo de demostracion', category: 'other', currency: 'COP' },
    occurrence: { periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-22', amount: '87400.00' },
  },
}

let hitl: Record<string, unknown>
const calls = { decision: 0, apply: 0 }

function setup(status: string, appliedAt: string | null) {
  hitl = {
    id: 'h1', caseId: 'c1', proposalId: 'p1', decisionType: 'data_confirmation', status, overdue: false,
    options: { summary: 'Registrar una nueva obligación de Aseo Verde por 87400.00, vence 2026-12-22.' },
    decision: status === 'pending' ? null : { outcome: 'approved' }, dueAt: '2026-11-12T17:28:21Z',
    respondedAt: status === 'pending' ? null : '2026-11-11T17:33:13Z', createdAt: 't', updatedAt: 't',
    proposal: {
      id: 'p1', caseId: 'c1', version: 1, source: 'llm', proposedData: aseo, documentId: 'd1',
      reviewStatus: status === 'pending' ? 'pending_review' : 'accepted', appliedAt, createdAt: 't', updatedAt: 't',
    },
  }
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/revisiones/h1']}>
          <ToastViewport />
          <Routes>
            <Route path="/revisiones/:id" element={<HitlDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}
const alertText = () => screen.getAllByRole('alert').map((a) => a.textContent).join(' ').trim()
const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}
const unauthorized = () => new ApiError(401, ['Autenticación requerida'], 'corr-401')

beforeEach(() => {
  vi.useFakeTimers()
  calls.decision = 0
  calls.apply = 0
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('401 durante una operación HITL', () => {
  it('aprobar con 401: una sola petición, sin reintentos, sin éxito y sin afirmar que no se registró nada', async () => {
    setup('pending', null)
    state.handler = (path) => {
      if (path === '/hitl-requests/h1/decision') {
        calls.decision += 1
        throw unauthorized()
      }
      if (path === '/hitl-requests/h1') return hitl
    }
    mount()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Aprobar propuesta' }))
    await settle()
    await settle(20) // si hubiera reintentos automáticos, aparecerían aquí

    expect(calls.decision).toBe(1)
    expect(alertText()).toMatch(/Tu sesión venció/)
    expect(document.body.textContent).not.toMatch(/Propuesta aprobada|Listo, quedó registrada|No se registró nada/)
    expect(screen.getByText('Pendiente de tu revisión')).toBeTruthy()
  })

  it('aplicar con 401: una sola petición, no marca la propuesta como aplicada y no hay segundo envío por doble clic', async () => {
    setup('approved', null)
    state.handler = (path) => {
      if (path === '/cases/c1/proposals/p1/apply') {
        calls.apply += 1
        throw unauthorized()
      }
      if (path === '/hitl-requests/h1') return hitl
    }
    mount()
    await settle()

    const apply = screen.getByRole('button', { name: 'Aplicar propuesta' })
    fireEvent.click(apply)
    fireEvent.click(apply)
    await settle(20)

    expect(calls.apply).toBe(1)
    expect(alertText()).toMatch(/Tu sesión venció/)
    expect(screen.queryByText('Propuesta aplicada.')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Cambio aplicado|No se registró nada/)
  })

  it('tras volver a entrar, el estado sale del servidor: si la aplicación sí se había registrado, no reaparece «Aplicar»', async () => {
    // Caso límite: la petición de aplicar llegó al servidor y se confirmó, pero la respuesta que
    // vio la persona fue un 401 (otra petición o pestaña con el token vencido). La pantalla no
    // debe suponer nada por el 401: al reabrir la revisión se lee el estado real.
    setup('approved', null)
    state.handler = (path) => {
      if (path === '/cases/c1/proposals/p1/apply') throw unauthorized()
      if (path === '/hitl-requests/h1') return hitl
    }
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar propuesta' }))
    await settle()
    cleanup() // se cierra la sesión: la pantalla se desmonta y la caché se descarta

    setup('approved', '2026-11-12T16:00:00Z') // el servidor sí lo había aplicado
    state.handler = (path) => {
      if (path === '/hitl-requests/h1') return hitl
    }
    mount()
    await settle()

    expect(screen.queryByRole('button', { name: 'Aplicar propuesta' })).toBeNull()
    expect(screen.getByText(/Aplicada/)).toBeTruthy()
  })

  it('tras volver a entrar sin que se hubiera aplicado, la persona puede aplicar una vez (acción explícita)', async () => {
    setup('approved', null)
    let applyCalls = 0
    state.handler = (path) => {
      if (path === '/cases/c1/proposals/p1/apply') {
        applyCalls += 1
        return { alreadyApplied: false, createdObligationId: 'o9', resource: { type: 'obligation_occurrence', id: 'oc9', obligationId: 'o9', status: 'pending' } }
      }
      if (path === '/hitl-requests/h1') return hitl
    }
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar propuesta' }))
    await settle()
    expect(applyCalls).toBe(1)
  })
})
