// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ hitl: {} as Record<string, unknown> }))
vi.mock('../../lib/api/client', () => ({ api: (path: string) => Promise.resolve().then(() => (path === '/hitl-requests/h1' ? state.hitl : undefined)) }))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'camila' }, isAuthenticated: true }) }))

import { ToastProvider } from '../../components/Toasts'
import { HitlDetailPage } from './HitlDetailPage'

const CONSEQUENCES =
  'Aprobar solo confirma los datos: no registra pagos ni mueve dinero. Después debes aplicar la propuesta de forma explícita, lo que crea un período PENDIENTE. Rechazar no registra nada.'

const informativa = {
  requiereRevisionManual: true,
  interpretacion: { providerName: 'Casa Firme Seguros S.A.', amount: '41800.00' },
  alertaSeguridad: { tipo: 'posible_inyeccion', senales: [], reportadoPorModelo: true },
}

function review(over: { decisionType: string; proposedData: unknown; options: Record<string, unknown> }) {
  state.hitl = {
    id: 'h1', caseId: 'c1', proposalId: 'p1', decisionType: over.decisionType, status: 'pending', overdue: false,
    options: over.options, decision: null, dueAt: '2026-11-13T17:28:21Z', respondedAt: null, createdAt: 't', updatedAt: 't',
    proposal: { id: 'p1', caseId: 'c1', version: 1, source: 'llm', proposedData: over.proposedData, documentId: 'd1', reviewStatus: 'pending_review', createdAt: 't', updatedAt: 't' },
  }
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/revisiones/h1']}>
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

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('revisiones no aplicables: textos coherentes con la acción disponible', () => {
  it('informativa («Entendido»): no muestra «Qué pasaría» ni habla de aplicar; la advertencia sí se ve', async () => {
    review({
      decisionType: 'other',
      proposedData: informativa,
      options: {
        summary: 'Atención: el documento contiene instrucciones dirigidas al sistema; se ignoraron. Revísalo y regístralo manualmente si es legítimo.',
        context: { consecuencias: CONSEQUENCES, advertencias: ['El documento contiene instrucciones dirigidas al sistema. Se trataron como texto y NO se ejecutaron.'] },
      },
    })
    mount()
    await settle()
    const text = document.body.textContent ?? ''
    expect(screen.getByRole('button', { name: 'Entendido' })).toBeTruthy()
    expect(text).not.toMatch(/Qué pasaría/)
    expect(text).not.toMatch(/aplicar la propuesta|crea un período PENDIENTE/)
    expect(text).toMatch(/Advertencias/)
    expect(text).toMatch(/instrucciones dirigidas al sistema/)
    expect(text).toMatch(/Con «Entendido» solo registras que revisaste este aviso: no se crea ni se cambia nada/)
  })

  it('con alternativas de importe: importes en formato colombiano, mensaje de elección y sin «Qué pasaría»', async () => {
    review({
      decisionType: 'conflict_resolution',
      proposedData: { requiereRevisionManual: true, camposProblematicos: ['varios valores posibles'] },
      options: {
        summary: 'La factura muestra varios valores posibles.',
        choices: [
          { key: 'valor_1', label: 'Valor propuesto: 99900.00' },
          { key: 'valor_2', label: 'Pago mínimo: 40000.50' },
          { key: 'valor_3', label: 'Total a pagar: $150.000' }, // ya formateado por el workflow: no se toca
        ],
        context: { consecuencias: CONSEQUENCES, advertencias: ['El documento muestra varios valores posibles; elige el correcto o regístralo manualmente.'] },
      },
    })
    mount()
    await settle()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Valor propuesto: \$99\.900/)
    expect(text).toMatch(/Pago mínimo: \$40\.000,50/)
    expect(text).toMatch(/Total a pagar: \$150\.000/)
    expect(text).not.toMatch(/99900\.00|40000\.50/)
    expect(text).not.toMatch(/Qué pasaría/)
    expect(text).toMatch(/Tu elección queda registrada y no ejecuta ningún cambio por sí sola/)
    expect(screen.getByRole('button', { name: 'Confirmar mi elección' })).toBeTruthy()
  })

  it('aplicable: «Qué pasaría» se conserva (aprobar ≠ aplicar)', async () => {
    review({
      decisionType: 'data_confirmation',
      proposedData: {
        action: 'create_obligation_with_occurrence',
        data: {
          obligation: { providerName: 'Casa Firme Seguros S.A.', concept: 'Seguro de hogar', category: 'other', currency: 'COP' },
          occurrence: { periodStart: '2026-12-01', periodEnd: '2026-12-31', dueDate: '2026-12-10', amount: '41800.00' },
        },
      },
      options: { summary: 'Factura de Casa Firme.', context: { consecuencias: CONSEQUENCES } },
    })
    mount()
    await settle()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Qué pasaría/)
    expect(text).toMatch(/Después debes aplicar la propuesta/)
    expect(screen.getByRole('button', { name: 'Aprobar propuesta' })).toBeTruthy()
  })
})
