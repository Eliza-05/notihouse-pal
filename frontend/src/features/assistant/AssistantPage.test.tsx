// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, RequestTimeoutError } from '../../lib/api/errors'

const state = vi.hoisted(() => ({
  handler: (_path: string, _opts?: { body?: unknown }): unknown => undefined,
  bodies: [] as Array<{ text: string; requestId: string }>,
}))
vi.mock('../../lib/api/client', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/client')>()),
  api: (path: string, o?: { body?: unknown }) => Promise.resolve().then(() => state.handler(path, o)),
}))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'camila' }, isAuthenticated: true }) }))
vi.mock('../../lib/useAudioRecorder', () => ({ useAudioRecorder: () => ({ status: 'idle', elapsedMs: 0, result: null, errorMessage: null, start: () => {}, stop: () => {}, reset: () => {} }) }))

import { ToastProvider, ToastViewport } from '../../components/Toasts'
import { AssistantPage } from './AssistantPage'

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <ToastViewport />
          <AssistantPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}
const alertText = () => screen.getAllByRole('alert').map((a) => a.textContent).join(' ').trim()
const type = (v: string) => fireEvent.change(screen.getByLabelText('Mensaje'), { target: { value: v } })
const send = () => fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }))

beforeEach(() => {
  vi.useFakeTimers()
  state.bodies = []
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('asistente de texto: errores y reintentos', () => {
  it('tras un timeout, reintentar el mismo texto reutiliza el requestId (el backend no duplica)', async () => {
    let n = 0
    state.handler = (_p, o) => {
      state.bodies.push(o!.body as { text: string; requestId: string })
      if (++n === 1) throw new RequestTimeoutError(true)
      return { caseId: 'c1' }
    }
    mount()
    type('Agua, 43 mil, vence el 20')
    send()
    await settle()
    expect(alertText()).toMatch(/sí se haya registrado/)
    expect(alertText()).not.toMatch(/perdi|no se registr/i)
    send()
    await settle()
    expect(state.bodies).toHaveLength(2)
    expect(state.bodies[1].requestId).toBe(state.bodies[0].requestId)
    expect(screen.getByRole('link', { name: 'Ver el avance' })).toBeTruthy()
  })

  it('si el texto cambia, es otra solicitud (otro requestId)', async () => {
    let n = 0
    state.handler = (_p, o) => {
      state.bodies.push(o!.body as { text: string; requestId: string })
      if (++n === 1) throw new TypeError('Failed to fetch')
      return { caseId: 'c1' }
    }
    mount()
    type('uno')
    send()
    await settle()
    expect(alertText()).toMatch(/No pudimos conectar con el servicio/)
    expect(alertText()).toMatch(/Mis solicitudes/)
    type('dos')
    send()
    await settle()
    expect(state.bodies[1].requestId).not.toBe(state.bodies[0].requestId)
  })

  it('tras un envío confirmado, enviar el mismo texto otra vez es una solicitud nueva', async () => {
    state.handler = (_p, o) => {
      state.bodies.push(o!.body as { text: string; requestId: string })
      return { caseId: 'c' + state.bodies.length }
    }
    mount()
    type('igual')
    send()
    await settle()
    type('igual')
    send()
    await settle()
    expect(state.bodies[1].requestId).not.toBe(state.bodies[0].requestId)
  })

  it('doble clic: una sola petición mientras se envía', async () => {
    let release!: () => void
    state.handler = (_p, o) => {
      state.bodies.push(o!.body as { text: string; requestId: string })
      return new Promise((r) => { release = () => r({ caseId: 'c1' }) })
    }
    mount()
    type('hola')
    const btn = screen.getByRole('button', { name: 'Enviar mensaje' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    await settle()
    expect(state.bodies).toHaveLength(1)
    release()
    await settle()
  })

  it('429 del servicio: mensaje comprensible, sin tecnicismos', async () => {
    state.handler = () => { throw new ApiError(429, ['Ya tienes 3 mensajes en proceso; espera a que se resuelvan antes de enviar otro'], 'c') }
    mount()
    type('hola')
    send()
    await settle()
    expect(alertText()).toMatch(/3 mensajes en proceso/)
    expect(document.body.textContent).not.toMatch(/Too Many|statusCode|Gemini|n8n/i)
  })
})
