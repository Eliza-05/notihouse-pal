// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: { id: 'camila' } as { id: string } | null,
  handler: (_path: string): unknown => undefined,
  fail: false,
}))
vi.mock('../../lib/api/client', () => ({
  api: (path: string) => (state.fail ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(state.handler(path))),
}))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: state.user, isAuthenticated: !!state.user }) }))

import { AppProviders } from '../../app/providers'
import { ToastProvider, ToastViewport } from '../../components/Toasts'
import { NotificationBell } from './NotificationBell'
import { NotificationToaster } from './NotificationToaster'
import { NotificationsProvider } from './NotificationsProvider'

const aseo = { action: 'create_obligation_with_occurrence', data: { obligation: { providerName: 'Aseo Verde de Prueba S.A.S.', concept: 'Aseo', category: 'other', currency: 'COP' }, occurrence: { periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-22', amount: '87400.00' } } }

const req = (id: string, over: Record<string, unknown> = {}) => ({
  id, caseId: `c-${id}`, proposalId: `p-${id}`, decisionType: 'data_confirmation', status: 'pending', overdue: false, options: {}, decision: null,
  createdAt: '2026-11-11T17:28:21Z', dueAt: '2026-11-12T17:28:21Z', respondedAt: null, updatedAt: 't', ...over,
})
const detail = (id: string) => ({
  ...req(id),
  proposal: { id: `p-${id}`, caseId: `c-${id}`, version: 1, source: 'llm', proposedData: aseo, documentId: 'd1', reviewStatus: 'pending_review', createdAt: 't', updatedAt: 't' },
})

let pending: Array<ReturnType<typeof req>> = []
let attention: unknown[] = []
const calls: string[] = []

function Harness() {
  return (
    <>
      <NotificationToaster />
      <ToastViewport />
      <NotificationBell />
    </>
  )
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <NotificationsProvider>
            <Harness />
          </NotificationsProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

/** Las consultas encadenadas (lista → detalle) necesitan varios ciclos para asentarse. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick(50)
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  calls.length = 0
  pending = []
  attention = []
  state.user = { id: 'camila' }
  state.fail = false
  state.handler = (path) => {
    calls.push(path)
    if (path.startsWith('/hitl-requests?status=pending')) return { items: pending, total: pending.length, page: 1, pageSize: 10 }
    if (path.startsWith('/hitl-requests?status=approved')) return { items: [], total: 0, page: 1, pageSize: 5 }
    const d = /^\/hitl-requests\/([^/?]+)$/.exec(path)
    if (d) return detail(d[1]!)
    if (path.startsWith('/attention')) return { referenceDate: '2026-11-11', items: attention, total: attention.length, page: 1, pageSize: 20 }
    if (path === '/alerts/summary') return { unread: 0 }
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const bell = () => screen.getByRole('button', { name: /Notificaciones/ })

describe('campana y avisos flotantes', () => {
  it('sin pendientes: la campana lo dice y no hay indicador', async () => {
    mount()
    await settle()
    expect(bell().getAttribute('aria-label')).toBe('Notificaciones, sin pendientes')
    fireEvent.click(bell())
    expect(screen.getByText('No tienes pendientes por ahora.')).toBeTruthy()
  })

  it('al iniciar con una revisión ya pendiente: indicador y panel, y solo UN resumen discreto (no un aviso por cada histórico)', async () => {
    pending = [req('h-old')]
    mount()
    await settle()
    expect(bell().getAttribute('aria-label')).toBe('Notificaciones, 1 por atender')
    expect(screen.getByText('Tienes 1 asunto por atender')).toBeTruthy()
    expect(screen.queryByText('Tienes una factura por revisar')).toBeNull() // no se anuncia como «nueva»
    fireEvent.click(bell())
    expect(screen.getByRole('button', { name: /Tienes una factura por revisar/ })).toBeTruthy()
    expect(screen.getByText(/Aseo Verde de Prueba S\.A\.S\. por \$87\.400/)).toBeTruthy()
  })

  it('una revisión nueva muestra un toast con acción hacia ESA revisión, una sola vez aunque el polling la vea varias veces', async () => {
    pending = []
    mount()
    await settle()
    pending = [req('h-new')]
    await tick(31_000)
    expect(screen.getAllByText('Tienes una factura por revisar')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Revisar factura' }).getAttribute('href')).toBe('/revisiones/h-new')
    expect(bell().getAttribute('aria-label')).toBe('Notificaciones, 1 por atender')
    // El toast se cierra solo y el siguiente ciclo NO lo repite.
    await tick(31_000)
    await tick(31_000)
    expect(screen.queryByText('Tienes una factura por revisar')).toBeNull()
  })

  it('si la persona está siendo llevada a esa misma revisión (p. ej. tras elegir una alternativa), no aparece un aviso redundante', async () => {
    let go: (to: string) => void = () => {}
    function Nav() {
      const n = useNavigate()
      go = (to) => n(to)
      return null
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/revisiones/h-old']}>
            <Nav />
            <NotificationsProvider>
              <Harness />
            </NotificationsProvider>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    )
    await settle()
    pending = [req('h-follow')]
    await tick(30_100) // el polling ve la revisión nueva…
    act(() => go('/revisiones/h-follow')) // …y la navegación llega justo después
    await tick(1_000)
    expect(screen.queryByText('Tienes una factura por revisar')).toBeNull()
    expect(bell().getAttribute('aria-label')).toBe('Notificaciones, 1 por atender') // la campana sí la conserva
  })

  it('al resolverse la revisión el aviso y el contador desaparecen', async () => {
    pending = [req('h1')]
    mount()
    await settle()
    expect(bell().getAttribute('aria-label')).toBe('Notificaciones, 1 por atender')
    pending = []
    await tick(31_000)
    expect(bell().getAttribute('aria-label')).toBe('Notificaciones, sin pendientes')
  })

  it('los vencimientos aparecen en la campana pero no generan toasts', async () => {
    attention = [{
      kind: 'obligation_occurrence', id: 'occ1', title: 'servicio de agua', description: 'Vence en 1 día', relevantDate: '2026-11-12', dueAt: null,
      status: 'pending', condition: 'due_today', priority: 3, daysUntil: 0, amount: '43200.00', currency: 'COP', suggestedAction: 'confirm_payment',
      resource: { type: 'obligation_occurrence', id: 'occ1', path: '/obligations/o1/occurrences/occ1' }, alert: null,
    }]
    mount()
    await settle()
    attention = [...attention]
    await tick(31_000)
    expect(document.querySelector('.toast')).toBeNull()
    fireEvent.click(bell())
    expect(screen.getByText('Próximos vencimientos')).toBeTruthy()
    expect(screen.getByText(/Vence en 1 día · \$43\.200/)).toBeTruthy()
  })

  it('el panel se cierra con Escape y devuelve el foco a la campana', async () => {
    mount()
    await settle()
    fireEvent.click(bell())
    expect(screen.getByRole('dialog', { name: 'Notificaciones' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Notificaciones' })).toBeNull()
    expect(document.activeElement).toBe(bell())
  })

  it('si no hay conexión: mensaje claro y reintento (sin quedarse cargando para siempre)', async () => {
    state.fail = true
    mount()
    await settle()
    fireEvent.click(bell())
    expect(screen.getByText('No pudimos actualizar tus avisos.')).toBeTruthy()
    expect(screen.queryByText('Cargando notificaciones…')).toBeNull()
    state.fail = false
    pending = [req('h1')]
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    await tick(0)
    expect(screen.queryByText('No pudimos actualizar tus avisos.')).toBeNull()
  })

  it('no consulta con la pestaña oculta y revalida al volver', async () => {
    mount()
    await settle()
    const n = calls.length
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await tick(120_000)
    expect(calls.length).toBe(n)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await tick(31_000)
    expect(calls.length).toBeGreaterThan(n)
  })
})

describe('aislamiento entre cuentas', () => {
  it('al cambiar de usuario no quedan avisos ni toasts del anterior', async () => {
    pending = [req('h-camila')]
    const tree = () => (
      <AppProviders>
        <MemoryRouter>
          <NotificationsProvider>
            <Harness />
          </NotificationsProvider>
        </MemoryRouter>
      </AppProviders>
    )
    const { rerender } = render(tree())
    await settle()
    expect(bell().getAttribute('aria-label')).toBe('Notificaciones, 1 por atender')

    // Daniel inicia sesión: el backend le devuelve SUS datos (ninguna revisión pendiente).
    pending = []
    state.user = { id: 'daniel' }
    rerender(tree())
    await settle()
    expect(bell().getAttribute('aria-label')).toBe('Notificaciones, sin pendientes')
    expect(document.querySelector('.toast')).toBeNull()
    fireEvent.click(bell())
    expect(screen.queryByText(/Aseo Verde/)).toBeNull()
  })
})
