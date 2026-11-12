// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const loginBody = (token: string, expiresIn = 7200) => ({
  accessToken: token,
  expiresIn,
  user: { id: 'u1', email: 'camila@demo.test', displayName: 'Camila' },
})

/** Módulos nuevos por prueba: la sesión es estado de módulo y los componentes la leen. */
async function loadApp() {
  vi.resetModules()
  const session = await import('../../lib/auth/session')
  const { LoginPage } = await import('./LoginPage')
  const { RequireAuth } = await import('../../app/RequireAuth')
  const { SessionExpiryBanner } = await import('../../components/SessionExpiryBanner')
  return { session, LoginPage, RequireAuth, SessionExpiryBanner }
}

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search + l.hash}</p>
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-11-12T15:00:00Z'))
  sessionStorage.clear()
  window.matchMedia = window.matchMedia ?? ((() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('login tras un cierre de sesión', () => {
  it('muestra un aviso persistente y comprensible si la sesión venció, y se puede descartar', async () => {
    sessionStorage.setItem('notihouse-pal.session-notice', JSON.stringify({ reason: 'expired', returnTo: '/obligaciones?estado=vencida' }))
    const { LoginPage } = await loadApp()
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('status').textContent).toMatch(/Tu sesión venció \(dura 2 horas\)/)
    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }))
    expect(screen.queryByText(/Tu sesión venció/)).toBeNull()
    expect(sessionStorage.getItem('notihouse-pal.session-notice')).toBeNull()
  })

  it('un 401 distinto del vencimiento muestra un texto propio', async () => {
    sessionStorage.setItem('notihouse-pal.session-notice', JSON.stringify({ reason: 'unauthorized', returnTo: null }))
    const { LoginPage } = await loadApp()
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('status').textContent).toMatch(/Tu sesión ya no es válida/)
  })

  it('sin cierre previo no hay aviso', async () => {
    const { LoginPage } = await loadApp()
    render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('al iniciar sesión vuelve a la ruta original CON parámetros de búsqueda y hash (estado de navegación)', async () => {
    const { LoginPage } = await loadApp()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1')))
    render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: { pathname: '/revisiones/h1', search: '?tab=detalle', hash: '#nota' } } }]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/correo/i), { target: { value: 'camila@demo.test' } })
    fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'una-clave-larga' } })
    fireEvent.submit(screen.getByRole('button', { name: /iniciar sesión|entrar|ingresar/i }).closest('form')!)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/revisiones/h1?tab=detalle#nota'))
  })

  it('si se recargó el login, vuelve a la ruta recordada por el aviso; una ruta manipulada se ignora', async () => {
    sessionStorage.setItem('notihouse-pal.session-notice', JSON.stringify({ reason: 'expired', returnTo: '//evil.example' }))
    const { LoginPage } = await loadApp()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1')))
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/correo/i), { target: { value: 'camila@demo.test' } })
    fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'una-clave-larga' } })
    fireEvent.submit(screen.getByRole('button', { name: /iniciar sesión|entrar|ingresar/i }).closest('form')!)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'))
  })
})

describe('RequireAuth y vencimiento proactivo', () => {
  it('al vencer, la pantalla protegida redirige a /login sin esperar a ninguna petición y conserva la ruta completa', async () => {
    const { session, LoginPage, RequireAuth } = await loadApp()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1', 7200)))
    await session.login({ email: 'a@b.c', password: 'x' })
    window.history.pushState({}, '', '/alertas?tipo=vencidas')

    render(
      <MemoryRouter initialEntries={['/alertas?tipo=vencidas']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/alertas" element={<RequireAuth><p>contenido protegido</p></RequireAuth>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('contenido protegido')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7200 * 1000 + 100)
    })

    expect(screen.queryByText('contenido protegido')).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/Tu sesión venció/)
    expect(session.getSessionNotice()).toEqual({ reason: 'expired', returnTo: '/alertas?tipo=vencidas' })
  })
})

describe('advertencia previa al vencimiento', () => {
  it('aparece unos 5 minutos antes, cuenta hacia atrás y desaparece al cerrar sesión', async () => {
    const { session, SessionExpiryBanner } = await loadApp()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1', 7200)))
    await session.login({ email: 'a@b.c', password: 'x' })
    render(<SessionExpiryBanner />)
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync((7200 - 5 * 60) * 1000 + 100)
    })
    expect(screen.getByRole('status').textContent).toMatch(/Tu sesión vence en 5 minutos/)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)
    })
    expect(screen.getByRole('status').textContent).toMatch(/vence en 2 minutos/)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1000)
    })
    expect(screen.queryByRole('status')).toBeNull() // ya venció: lo explica el login
  })

  it('no se muestra con margen amplio ni sin sesión', async () => {
    const { session, SessionExpiryBanner } = await loadApp()
    render(<SessionExpiryBanner />)
    expect(screen.queryByRole('status')).toBeNull()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1', 7200)))
    await act(async () => {
      await session.login({ email: 'a@b.c', password: 'x' })
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
