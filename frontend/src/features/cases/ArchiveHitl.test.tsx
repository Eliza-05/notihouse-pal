// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handler: (_path: string, _opts?: { body?: unknown; method?: string }): unknown => undefined,
}))
vi.mock('../../lib/api/client', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/client')>()),
  api: (path: string, o?: { body?: unknown; method?: string }) => Promise.resolve().then(() => state.handler(path, o)),
}))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'camila' }, isAuthenticated: true }) }))

import { ToastProvider, ToastViewport } from '../../components/Toasts'
import { HitlDetailPage } from './HitlDetailPage'

const archiveProposal = {
  action: 'archive_obligation',
  data: { obligationId: 'o1', expected: { providerName: 'Internet Claro Hogar', concept: 'Servicio de internet' } },
}

let hitl: Record<string, unknown>
let decisions: Array<{ decision: string; choice?: string }> = []
let applyCalls = 0

function archiveReview(status: 'pending' | 'approved', appliedAt?: string | null) {
  const proposal: Record<string, unknown> = {
    id: 'p2', caseId: 'c1', version: 2, source: 'user', proposedData: archiveProposal, documentId: null,
    reviewStatus: status === 'pending' ? 'pending_review' : 'accepted', createdAt: 't', updatedAt: 't',
  }
  if (appliedAt !== undefined) proposal.appliedAt = appliedAt
  hitl = {
    id: 'h2', caseId: 'c1', proposalId: 'p2', decisionType: 'data_confirmation', status, overdue: false,
    options: { summary: 'Archivar la obligación de Internet Claro Hogar (Servicio de internet).', context: { consecuencias: 'Aprobar solo confirma. Después debes aplicar para archivarla.', advertencias: ['Tiene 1 período pendiente que se conserva sin cambios y seguirás viendo hasta que lo resuelvas.'] } },
    decision: status === 'approved' ? { outcome: 'approved' } : null, dueAt: '2026-11-12T17:28:21Z',
    respondedAt: status === 'approved' ? '2026-11-11T17:33:13Z' : null, createdAt: 't', updatedAt: 't', proposal,
  }
}

function choiceReview(withContinuation = true) {
  hitl = {
    id: 'h1', caseId: 'c1', proposalId: 'p1', decisionType: 'conflict_resolution', status: 'pending', overdue: false,
    options: {
      summary: 'Varias obligaciones coinciden con tu mensaje. ¿Cuál quieres archivar?',
      choices: [
        { key: 'o1', label: 'Claro Hogar · Internet Claro Hogar · $89.900' },
        { key: 'o2', label: 'Movistar · Internet Movistar · $75.000' },
      ],
      context: { kind: 'target_selection', ...(withContinuation ? { continuation: { intent: 'archive_obligation' } } : {}) },
    },
    decision: null, dueAt: '2026-11-12T17:28:21Z', respondedAt: null, createdAt: 't', updatedAt: 't',
    proposal: { id: 'p1', caseId: 'c1', version: 1, source: 'llm', proposedData: { resultado: 'needs_choice', requiereRevisionManual: true }, documentId: null, reviewStatus: 'pending_review', createdAt: 't', updatedAt: 't' },
  }
}

function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <ToastViewport />
          <Routes>
            <Route path="/revisiones/:id" element={<HitlDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}

beforeEach(() => {
  vi.useFakeTimers()
  decisions = []
  applyCalls = 0
  state.handler = (path, opts) => {
    if (path === '/hitl-requests/h1/decision') {
      const body = opts?.body as { decision: string; choice?: string }
      decisions.push(body)
      archiveReview('pending')
      return { ...(hitl as object), id: 'h1', status: 'approved', decision: { outcome: 'approved', choice: body.choice, followUpRequestId: 'h2' }, respondedAt: 't' }
    }
    if (path === '/hitl-requests/h2/decision') {
      decisions.push(opts?.body as { decision: string })
      archiveReview('approved', null)
      return hitl
    }
    if (path === '/hitl-requests/h1' || path === '/hitl-requests/h2') return hitl
    if (path === '/cases/c1/proposals/p2/apply') {
      applyCalls++
      archiveReview('approved', '2026-11-11T18:00:00Z')
      return { alreadyApplied: false, createdObligationId: null, resource: { type: 'obligation', id: 'o1', obligationId: 'o1' } }
    }
    if (path === '/obligations/o1') return { id: 'o1', providerName: 'Internet Claro Hogar', concept: 'Servicio de internet', status: 'active' }
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('propuesta de archivado (HITL)', () => {
  it('muestra qué se archiva y qué se conserva; no se puede aplicar antes de aprobar', async () => {
    archiveReview('pending')
    mount('/revisiones/h2')
    await settle()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Archivar obligación de Internet Claro Hogar')
    expect(screen.getAllByText(/Dejará de generar períodos nuevos/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Se conservan su historial, documentos y pagos/)).toBeTruthy()
    expect(screen.getByText(/Tiene 1 período pendiente/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Aprobar propuesta' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Aplicar propuesta' })).toBeNull()
  })

  it('aprobar ≠ aplicar: tras aprobar (appliedAt = null) aparece Aplicar; aplicar una vez muestra «aplicada»', async () => {
    archiveReview('pending')
    mount('/revisiones/h2')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar propuesta' }))
    await settle()
    expect(screen.getByText('Aprobada, falta aplicar')).toBeTruthy()
    const apply = screen.getByRole('button', { name: 'Aplicar propuesta' })
    fireEvent.click(apply)
    fireEvent.click(apply)
    await settle()
    expect(applyCalls).toBe(1)
    expect(screen.getAllByText('Aplicada').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Aplicar propuesta' })).toBeNull()
  })

  it('al recargar una propuesta ya aplicada no reaparece Aplicar', async () => {
    archiveReview('approved', '2026-11-11T18:00:00Z')
    mount('/revisiones/h2')
    await settle()
    expect(screen.queryByRole('button', { name: 'Aplicar propuesta' })).toBeNull()
    expect(screen.getAllByText('Aplicada').length).toBeGreaterThan(0)
  })
})

describe('selector de alternativas con continuación (A-7)', () => {
  it('muestra proveedor, concepto e importe (sin UUID) y explica que elegir no cambia nada', async () => {
    choiceReview()
    mount('/revisiones/h1')
    await settle()
    expect(screen.getByLabelText('Claro Hogar · Internet Claro Hogar · $89.900')).toBeTruthy()
    expect(screen.getByLabelText('Movistar · Internet Movistar · $75.000')).toBeTruthy()
    expect(screen.getByText(/Elegir no cambia nada todavía/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\bo1\b|\bo2\b/)
    expect(screen.getByRole('button', { name: 'Continuar con la seleccionada' })).toBeTruthy()
  })

  it('sin elegir no continúa y pide elegir', async () => {
    choiceReview()
    mount('/revisiones/h1')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Continuar con la seleccionada' }))
    await settle()
    expect(decisions).toHaveLength(0)
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/Elige una alternativa/)
  })

  it('elegir envía la alternativa y continúa automáticamente en la nueva revisión de archivado', async () => {
    choiceReview()
    mount('/revisiones/h1')
    await settle()
    fireEvent.click(screen.getByLabelText('Movistar · Internet Movistar · $75.000'))
    const go = screen.getByRole('button', { name: 'Continuar con la seleccionada' })
    fireEvent.click(go)
    fireEvent.click(go)
    await settle()
    expect(decisions).toEqual([{ decision: 'approved', choice: 'o2', comment: undefined }])
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Archivar obligación de Internet Claro Hogar')
    expect(screen.getByRole('button', { name: 'Aprobar propuesta' })).toBeTruthy()
  })
})
