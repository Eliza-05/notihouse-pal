// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api/errors'

const state = vi.hoisted(() => ({
  handler: (_path: string, _opts?: { method?: string }): unknown => undefined,
  uploads: 0,
}))
vi.mock('../../lib/api/client', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/client')>()),
  api: (path: string, o?: { method?: string }) => Promise.resolve().then(() => state.handler(path, o)),
}))
vi.mock('../../lib/auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'camila' }, isAuthenticated: true }) }))

import { ToastProvider, ToastViewport } from '../../components/Toasts'
import { DocumentsPage } from './DocumentsPage'

let release: (() => void) | null = null

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <ToastViewport />
          <DocumentsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}
const pick = (file: File) => fireEvent.change(screen.getByLabelText('Elegir factura PDF'), { target: { files: [file] } })
const pdf = (name = 'factura.pdf', size = 1000) => {
  const f = new File(['%PDF-1.4'], name, { type: 'application/pdf' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const alertText = () => screen.getAllByRole('alert').map((a) => a.textContent).join(' ').trim()

beforeEach(() => {
  vi.useFakeTimers()
  state.uploads = 0
  release = null
  state.handler = (path, opts) => {
    if (path.startsWith('/documents') && opts?.method !== 'POST') return { items: [{ id: 'd1', type: 'invoice', source: 'gmail', fileName: 'ENS-1114.pdf', caseId: 'c1', createdAt: '2026-11-11T17:28:14Z' }], total: 1, page: 1, pageSize: 50 }
    if (path === '/ingestions/documents') {
      state.uploads++
      return { documentId: 'd2', caseId: 'c2', duplicateContent: false }
    }
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('subida de facturas', () => {
  it('la lista muestra tipo y origen en español, no «invoice» ni «gmail»', async () => {
    mount()
    await settle()
    expect(screen.getByText('Factura')).toBeTruthy()
    expect(screen.getByText('Correo')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\binvoice\b|\bgmail\b/)
  })

  it('un archivo que no es PDF se rechaza en el navegador con una explicación, sin llamar al servidor', async () => {
    mount()
    await settle()
    pick(new File(['x'], 'foto.png', { type: 'image/png' }))
    await settle()
    expect(alertText()).toMatch(/Solo se admiten facturas en PDF/)
    expect(state.uploads).toBe(0)
  })

  it('un PDF demasiado grande se rechaza con un mensaje claro', async () => {
    mount()
    await settle()
    pick(pdf('grande.pdf', 11 * 1024 * 1024))
    await settle()
    expect(alertText()).toMatch(/demasiado grande/)
    expect(state.uploads).toBe(0)
  })

  it('subida correcta: «Recibimos tu documento», procesamiento en segundo plano y enlace al avance', async () => {
    mount()
    await settle()
    pick(pdf('ENS-1114-aseo.pdf'))
    await settle()
    expect(state.uploads).toBe(1)
    expect(screen.getByText(/Recibimos «ENS-1114-aseo\.pdf»/)).toBeTruthy()
    expect(screen.getByText(/puedes seguir usando la aplicación/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Ver el avance' }).getAttribute('href')).toBe('/casos/c2')
  })

  it('mientras sube: indicador y sin segunda subida; al terminar desaparece', async () => {
    state.handler = (path, opts) => {
      if (path === '/ingestions/documents') {
        state.uploads++
        return new Promise((resolve) => { release = () => resolve({ documentId: 'd2', caseId: 'c2', duplicateContent: false }) })
      }
      if (opts?.method !== 'POST') return { items: [], total: 0, page: 1, pageSize: 50 }
    }
    mount()
    await settle()
    pick(pdf())
    await settle()
    expect(screen.getByText('Enviando tu factura…')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Subir factura PDF/ }).getAttribute('aria-busy')).toBe('true')
    pick(pdf('otra.pdf')) // un segundo intento mientras sube no debe duplicar la petición
    await settle()
    expect(state.uploads).toBe(1)
    release?.()
    await settle()
    expect(screen.queryByText('Enviando tu factura…')).toBeNull()
    expect(state.uploads).toBe(1)
  })

  it('415 por PDF con contenido activo: explica cómo regenerarlo y detiene el indicador', async () => {
    state.handler = (path, opts) => {
      if (path === '/ingestions/documents') throw new ApiError(415, ['El PDF contiene contenido activo (JavaScript, acciones o archivos incrustados) y no se admite'], 'c')
      if (opts?.method !== 'POST') return { items: [], total: 0, page: 1, pageSize: 50 }
    }
    mount()
    await settle()
    pick(pdf())
    await settle()
    expect(alertText()).toMatch(/elementos interactivos o archivos incrustados/)
    expect(alertText()).toMatch(/Guardar como PDF/)
    expect(screen.queryByText('Enviando tu factura…')).toBeNull()
    expect(screen.queryByText(/Recibimos «/)).toBeNull() // un fallo nunca se presenta como éxito
  })

  it('409 por duplicado y red caída: mensajes comprensibles', async () => {
    state.handler = (path, opts) => {
      if (path === '/ingestions/documents') throw new ApiError(409, ['Esta factura ya fue registrada'], 'c')
      if (opts?.method !== 'POST') return { items: [], total: 0, page: 1, pageSize: 50 }
    }
    mount()
    await settle()
    pick(pdf())
    await settle()
    expect(alertText()).toMatch(/Esta factura ya fue registrada/)

    state.handler = (path, opts) => {
      if (path === '/ingestions/documents') throw new TypeError('Failed to fetch')
      if (opts?.method !== 'POST') return { items: [], total: 0, page: 1, pageSize: 50 }
    }
    pick(pdf('otra.pdf'))
    await settle()
    expect(alertText()).toMatch(/No pudimos conectar con el servicio/)
  })

  it('el mismo archivo ya subido: avisa que se registró de nuevo para evitar duplicar la obligación', async () => {
    state.handler = (path, opts) => {
      if (path === '/ingestions/documents') return { documentId: 'd3', caseId: 'c3', duplicateContent: true }
      if (opts?.method !== 'POST') return { items: [], total: 0, page: 1, pageSize: 50 }
    }
    mount()
    await settle()
    pick(pdf())
    await settle()
    expect(screen.getByText(/ya se había subido antes/)).toBeTruthy()
  })

  it('la zona de carga se puede usar con el teclado', async () => {
    mount()
    await settle()
    const zone = screen.getByRole('button', { name: /Subir factura PDF/ })
    expect(zone.getAttribute('tabindex')).toBe('0')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.keyDown(zone, { key: 'Enter' })
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })
})
