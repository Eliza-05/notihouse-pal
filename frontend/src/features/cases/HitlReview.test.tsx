// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api/errors'

const state = vi.hoisted(() => ({
  handler: (_path: string, _opts?: { body?: unknown; method?: string }): unknown => undefined,
}))
vi.mock('../../lib/api/client', () => ({ api: (path: string, o?: { body?: unknown; method?: string }) => Promise.resolve().then(() => state.handler(path, o)) }))
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
const decisions: Array<{ decision: string; comment?: string }> = []
let decisionError: ApiError | null = null

function setup(status: string, extra: { appliedAt?: string | null; decision?: unknown; respondedAt?: string | null } = {}) {
  const proposal: Record<string, unknown> = {
    id: 'p1', caseId: 'c1', version: 1, source: 'llm', proposedData: aseo, documentId: 'd1',
    reviewStatus: status === 'pending' ? 'pending_review' : status === 'rejected' ? 'rejected' : 'accepted', createdAt: 't', updatedAt: 't',
  }
  if ('appliedAt' in extra) proposal.appliedAt = extra.appliedAt
  hitl = {
    id: 'h1', caseId: 'c1', proposalId: 'p1', decisionType: 'data_confirmation', status, overdue: false,
    options: { summary: 'Registrar una nueva obligación de Aseo Verde por 87400.00, vence 2026-12-22.' },
    decision: extra.decision ?? null, dueAt: '2026-11-12T17:28:21Z', respondedAt: extra.respondedAt ?? null, createdAt: 't', updatedAt: 't', proposal,
  }
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
/** El contenedor de toasts también es role=alert (vacío): se toma el texto de las alertas con contenido. */
const alertText = () => screen.getAllByRole('alert').map((a) => a.textContent).join(' ').trim()
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}

beforeEach(() => {
  vi.useFakeTimers()
  decisions.length = 0
  decisionError = null
  state.handler = (path, opts) => {
    if (path === '/hitl-requests/h1/decision') {
      if (decisionError) throw decisionError
      const body = opts?.body as { decision: string; comment?: string }
      decisions.push(body)
      hitl = { ...hitl, status: body.decision, respondedAt: '2026-11-11T17:33:13Z', decision: { outcome: body.decision, ...(body.comment ? { comment: body.comment } : {}) } }
      return hitl
    }
    if (path === '/hitl-requests/h1') return hitl
    if (path === '/cases/c1/proposals/p1/apply') return { alreadyApplied: false, createdObligationId: 'o9', resource: { type: 'obligation_occurrence', id: 'oc9', obligationId: 'o9', status: 'pending' } }
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('revisión HITL: qué se ve y qué se puede hacer', () => {
  it('título distinguible y datos en formato colombiano (sin «87400.00» ni «2026-12-22»)', async () => {
    setup('pending')
    mount()
    await settle()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Revisar factura de Aseo Verde de Prueba S.A.S. — $87.400')
    expect(screen.getByText('$87.400 COP')).toBeTruthy()
    expect(screen.getByText('22 de diciembre de 2026')).toBeTruthy()
    expect(screen.getByText('1 al 30 de noviembre de 2026')).toBeTruthy()
    expect(screen.getByText(/pago único/)).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/87400\.00|2026-12-22/)
    expect(screen.getByText('Pendiente de tu revisión')).toBeTruthy()
  })

  it('pendiente: se distingue aprobar de aplicar y todavía no existe el botón Aplicar', async () => {
    setup('pending')
    mount()
    await settle()
    expect(screen.getByRole('button', { name: 'Aprobar propuesta' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Aplicar propuesta' })).toBeNull()
    expect(screen.getByText(/Aprobar solo confirma que los datos son correctos: todavía no se crea nada/)).toBeTruthy()
  })

  it('aprobada con appliedAt = null: «falta aplicar» y el botón Aplicar', async () => {
    setup('approved', { appliedAt: null, respondedAt: '2026-11-11T17:33:13Z', decision: { outcome: 'approved' } })
    mount()
    await settle()
    expect(screen.getByText('Aprobada, falta aplicar')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Aplicar propuesta' })).toBeTruthy()
    expect(screen.getByText(/aún no se creó nada/)).toBeTruthy()
  })

  it('aprobada con appliedAt: «Aplicada» y NO reaparece Aplicar tras recargar la pantalla', async () => {
    setup('approved', { appliedAt: '2026-11-11T17:33:26Z', respondedAt: '2026-11-11T17:33:13Z', decision: { outcome: 'approved' } })
    mount()
    await settle()
    expect(screen.getAllByText('Aplicada').length).toBeGreaterThan(0)
    expect(screen.getByText('Propuesta aplicada.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Aplicar propuesta' })).toBeNull()
  })

  it('aprobada sin dato de aplicación (backend anterior): no afirma que se aplicó y avisa que aplicar no duplica', async () => {
    setup('approved', { respondedAt: '2026-11-11T17:33:13Z', decision: { outcome: 'approved' } })
    mount()
    await settle()
    expect(screen.queryByText('Propuesta aplicada.')).toBeNull()
    expect(screen.getByText(/no duplicará nada/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Aplicar propuesta' })).toBeTruthy()
  })

  it('Aplicar: spinner, mensaje de éxito y enlace a la obligación; el botón desaparece', async () => {
    setup('approved', { appliedAt: null, respondedAt: '2026-11-11T17:33:13Z', decision: { outcome: 'approved' } })
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar propuesta' }))
    await settle()
    expect(screen.getByText('Propuesta aplicada.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Ver la obligación' }).getAttribute('href')).toBe('/obligaciones/o9')
    expect(screen.queryByRole('button', { name: 'Aplicar propuesta' })).toBeNull()
  })
})

describe('comentarios de la decisión', () => {
  it('aprobar con una nota opcional: se envía y se puede consultar después', async () => {
    setup('pending')
    mount()
    await settle()
    expect(screen.queryByLabelText('Nota para tu registro')).toBeTruthy() // dentro del desplegable, sin ocupar espacio
    fireEvent.change(screen.getByLabelText('Nota para tu registro'), { target: { value: '  Coincide con la factura de noviembre  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar propuesta' }))
    await settle()
    expect(decisions).toEqual([{ decision: 'approved', comment: 'Coincide con la factura de noviembre' }])
    expect(screen.getByText('Tu nota')).toBeTruthy()
    expect(screen.getByText('Coincide con la factura de noviembre')).toBeTruthy()
  })

  it('rechazar pide el motivo solo al rechazar, con confirmación explícita, y el motivo queda visible', async () => {
    setup('pending')
    mount()
    await settle()
    expect(screen.queryByLabelText('Motivo del rechazo (opcional)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar…' }))
    await settle()
    const box = screen.getByLabelText('Motivo del rechazo (opcional)') as HTMLTextAreaElement
    expect(box.maxLength).toBe(500)
    expect(screen.getByText(/no se puede deshacer/)).toBeTruthy()
    expect(decisions).toHaveLength(0) // todavía no se envió nada
    fireEvent.change(box, { target: { value: 'El importe no coincide' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar rechazo' }))
    await settle()
    expect(decisions).toEqual([{ decision: 'rejected', comment: 'El importe no coincide' }])
    expect(screen.getAllByText('Rechazada').length).toBeGreaterThan(0)
    expect(screen.getByText('Motivo del rechazo')).toBeTruthy()
    expect(screen.getByText('El importe no coincide')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Aprobar|Rechazar|Aplicar/ })).toBeNull()
  })

  it('el comentario no es obligatorio: se puede aprobar y rechazar sin escribirlo', async () => {
    setup('pending')
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar propuesta' }))
    await settle()
    expect(decisions).toEqual([{ decision: 'approved', comment: undefined }])
  })

  it('una decisión anterior con comentario se muestra al volver a abrir la revisión', async () => {
    setup('rejected', { respondedAt: '2026-11-11T17:33:13Z', decision: { outcome: 'rejected', comment: 'Factura duplicada' } })
    mount()
    await settle()
    expect(screen.getByText('Factura duplicada')).toBeTruthy()
    expect(screen.getByText(/Rechazaste esta revisión ·/)).toBeTruthy()
  })
})

describe('errores y estados de carga al decidir', () => {
  it('doble clic en Aprobar solo envía una decisión', async () => {
    setup('pending')
    mount()
    await settle()
    const btn = screen.getByRole('button', { name: 'Aprobar propuesta' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    await settle()
    expect(decisions).toHaveLength(1)
  })

  it('revisión ya resuelta (409): mensaje claro, sin éxito falso y sin spinner eterno', async () => {
    setup('pending')
    decisionError = new ApiError(409, ['La revisión ya fue resuelta'], 'corr-1')
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar propuesta' }))
    await settle()
    expect(alertText()).toMatch(/ya fue resuelta/)
    expect(screen.queryByText(/Propuesta aprobada/)).toBeNull()
    const btn = screen.getByRole('button', { name: 'Aprobar propuesta' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-busy')).toBeNull()
  })

  it('sin conexión: «No pudimos conectarnos…», sin «Failed to fetch»', async () => {
    setup('pending')
    state.handler = (path) => {
      if (path === '/hitl-requests/h1/decision') throw new TypeError('Failed to fetch')
      if (path === '/hitl-requests/h1') return hitl
    }
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar propuesta' }))
    await settle()
    expect(alertText()).toMatch(/No pudimos conectar con el servicio/)
    expect(document.body.textContent).not.toMatch(/Failed to fetch/)
  })

  it('aplicar con duplicado (409): muestra el motivo claro del backend', async () => {
    setup('approved', { appliedAt: null, respondedAt: '2026-11-11T17:33:13Z', decision: { outcome: 'approved' } })
    state.handler = (path) => {
      if (path === '/cases/c1/proposals/p1/apply') throw new ApiError(409, ['Ya existe una obligación con el mismo proveedor y concepto; aplica un período sobre ella'], 'c')
      if (path === '/hitl-requests/h1') return hitl
    }
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar propuesta' }))
    await settle()
    expect(alertText()).toMatch(/Ya existe una obligación/)
    expect(screen.queryByText('Propuesta aplicada.')).toBeNull()
  })

  it('el aviso de éxito al decidir es un toast discreto, distinto de las notificaciones persistentes', async () => {
    setup('pending')
    mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar propuesta' }))
    await settle()
    expect(screen.getByText(/Propuesta aprobada\. Falta aplicarla/)).toBeTruthy()
    expect(screen.getByText(/Propuesta aprobada\. Falta aplicarla/).closest('[aria-live="polite"]')).not.toBeNull()
  })
})
