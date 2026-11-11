// @vitest-environment jsdom
import { focusManager, QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  handler: (_path: string, _opts?: unknown): unknown => undefined,
}))
vi.mock('../../lib/api/client', () => ({ api: (path: string, o?: unknown) => Promise.resolve(state.handler(path, o)) }))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: state.user, isAuthenticated: !!state.user }) }))

import { AppProviders } from '../../app/providers'
import { CaseDetailPage } from './CaseDetailPage'
import { HitlDetailPage } from './HitlDetailPage'

const calls: string[] = []
const count = (prefix: string) => calls.filter((c) => c === prefix || c.startsWith(prefix + '?')).length
let caseStatus = 'processing'
let hitlList: unknown[] = []

function mountCase() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/casos/c1']}>
        <Routes>
          <Route path="/casos/:id" element={<CaseDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { qc, ...utils }
}
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  calls.length = 0
  caseStatus = 'processing'
  hitlList = []
  state.user = { id: 'u1' }
  state.handler = (path) => {
    calls.push(path)
    if (path === '/cases/c1')
      return { id: 'c1', type: 'household_obligation', source: 'document', status: caseStatus, createdAt: '2026-11-10T10:00:00Z', statusReason: null }
    if (path.startsWith('/cases/c1/proposals')) return { items: [], total: 0, page: 1, pageSize: 20 }
    if (path.startsWith('/hitl-requests')) return { items: hitlList, total: hitlList.length, page: 1, pageSize: 10 }
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  focusManager.setFocused(undefined)
})

describe('detalle de caso sin F5', () => {
  it('processing → awaiting_human: "Revisar" aparece solo, sin recargar', async () => {
    mountCase()
    await tick(0)
    expect(screen.queryByText('Revisar')).toBeNull()
    caseStatus = 'awaiting_human'
    hitlList = [{ id: 'h1', caseId: 'c1', status: 'pending' }]
    await tick(5_000)
    expect(screen.getByText('Revisar').getAttribute('href')).toBe('/revisiones/h1')
  })

  it('awaiting_human → completed: se actualiza el estado y se detiene el polling', async () => {
    caseStatus = 'awaiting_human'
    hitlList = [{ id: 'h1', caseId: 'c1', status: 'pending' }]
    mountCase()
    await tick(0)
    expect(screen.getAllByText('Esperando tu decisión').length).toBeGreaterThan(0)
    caseStatus = 'completed'
    hitlList = [{ id: 'h1', caseId: 'c1', status: 'approved' }]
    await tick(10_000)
    expect(screen.getAllByText('Completado').length).toBeGreaterThan(0)
    expect(screen.queryByText('Revisar')).toBeNull()
    const n = calls.length
    await tick(60_000)
    expect(calls.length).toBe(n)
  })

  it('pestaña oculta: no consulta; al volver al foco revalida', async () => {
    mountCase()
    await tick(0)
    focusManager.setFocused(false)
    const n = count('/cases/c1')
    await tick(30_000)
    expect(count('/cases/c1')).toBe(n)
    caseStatus = 'awaiting_human'
    focusManager.setFocused(true)
    await tick(0)
    expect(count('/cases/c1')).toBeGreaterThan(n)
    expect(screen.getAllByText('Esperando tu decisión').length).toBeGreaterThan(0)
  })

  it('al desmontar se limpian los intervalos', async () => {
    const { unmount } = mountCase()
    await tick(0)
    unmount()
    const n = calls.length
    await tick(60_000)
    expect(calls.length).toBe(n)
  })
})

describe('revisión HITL', () => {
  const proposal = (data: unknown) => ({ id: 'p1', caseId: 'c1', version: 2, source: 'llm', proposedData: data, reviewStatus: 'accepted' })
  let hitl: Record<string, unknown>
  let obligationDay = 15

  function mountHitl() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/revisiones/h1']}>
          <Routes>
            <Route path="/revisiones/:id" element={<HitlDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }
  function setup(decisionType: string, data: unknown, options: unknown = { summary: 'Falta providerName' }) {
    obligationDay = 15
    hitl = { id: 'h1', caseId: 'c1', proposalId: 'p1', decisionType, status: 'pending', overdue: false, options, decision: null, dueAt: '2026-11-11T10:00:00Z', proposal: proposal(data) }
    state.handler = (path) => {
      calls.push(path)
      if (path === '/hitl-requests/h1/decision') {
        hitl = { ...hitl, status: 'approved' }
        return hitl
      }
      if (path === '/hitl-requests/h1') return hitl
      if (path === '/cases/c1/proposals/p1/apply') {
        obligationDay = 20
        return { alreadyApplied: false }
      }
      if (path === '/obligations/o1') return { id: 'o1', dueDay: obligationDay, reminderDaysBefore: 3, expectedAmount: '98500.00', currency: 'COP' }
    }
  }

  it('informativa: botón "Entendido", jamás "Aprobar" ni "Aplicar"; sin claves técnicas', async () => {
    setup('other', { requiereRevisionManual: true, camposProblematicos: ['valor'] })
    mountHitl()
    await tick(0)
    expect(screen.getByText('Entendido')).toBeTruthy()
    expect(screen.queryByText('Aprobar')).toBeNull()
    expect(screen.queryByText('Aplicar')).toBeNull()
    expect(screen.queryByText(/providerName/)).toBeNull()
    expect(screen.getByText(/Falta proveedor/)).toBeTruthy()
    fireEvent.click(screen.getByText('Entendido'))
    await tick(0)
    expect(calls).toContain('/hitl-requests/h1/decision') // misma transición de servidor: approved
    expect(screen.queryByText('Aplicar')).toBeNull()
    expect(screen.getByText(/No se creó ni se cambió ningún dato/)).toBeTruthy()
  })

  it('aplicable: Aprobar → aparece Aplicar → el cambio de vencimiento se refleja sin recargar', async () => {
    setup('data_confirmation', {
      action: 'update_obligation_schedule',
      data: { obligationId: 'o1', expected: { dueDay: 15 }, changes: { dueDay: 20, expectedAmount: '98500.00' } },
    })
    mountHitl()
    await tick(0)
    expect(screen.queryByText('Aplicar')).toBeNull()
    fireEvent.click(screen.getByText('Aprobar'))
    await tick(0)
    const before = count('/obligations/o1')
    fireEvent.click(screen.getByText('Aplicar'))
    await tick(0)
    expect(screen.getByText('Cambio aplicado correctamente.')).toBeTruthy()
    expect(count('/obligations/o1')).toBeGreaterThan(before)
    expect(screen.getAllByText('20').length).toBeGreaterThan(0)
  })

  it('crear obligación recurrente muestra el monto esperado', async () => {
    setup('data_confirmation', {
      action: 'create_recurring_obligation',
      data: { obligation: { providerName: 'Claro', concept: 'Internet', category: 'internet', expectedAmount: '98500.00', dueDay: 15 } },
    })
    mountHitl()
    await tick(0)
    expect(screen.getByText('$98.500,00')).toBeTruthy()
  })
})

describe('aislamiento entre usuarios', () => {
  it('al cambiar de usuario o cerrar sesión se vacía la caché', async () => {
    let client: QueryClient | undefined
    function Probe() {
      client = useQueryClient()
      return null
    }
    const tree = () => (
      <AppProviders>
        <Probe />
      </AppProviders>
    )
    const { rerender } = render(tree())
    await tick(0)
    client!.setQueryData(['u1', 'case', 'c1'], { status: 'processing' })
    state.user = { id: 'u2' }
    rerender(tree())
    await tick(0)
    expect(client!.getQueryData(['u1', 'case', 'c1'])).toBeUndefined()
    client!.setQueryData(['u2', 'case', 'c1'], { status: 'x' })
    state.user = null
    rerender(tree())
    await tick(0)
    expect(client!.getQueryData(['u2', 'case', 'c1'])).toBeUndefined()
  })
})
