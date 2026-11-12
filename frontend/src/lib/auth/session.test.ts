// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const loginBody = (token: string, expiresIn = 7200) => ({
  accessToken: token,
  expiresIn,
  user: { id: 'u1', email: 'camila@demo.test', displayName: 'Camila' },
})

const credentials = { email: 'a@b.c', password: 'x' }

/** Módulos nuevos en cada prueba: la sesión es estado de módulo. */
async function load() {
  vi.resetModules()
  const session = await import('./session')
  const client = await import('../api/client')
  return { session, client }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-12T15:00:00Z'))
  sessionStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('sesión: 401 y token vigente', () => {
  it('un 401 con el token vigente cierra la sesión y deja un aviso persistente con la ruta', async () => {
    const { session } = await load()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1')))
    await session.login(credentials)
    window.history.pushState({}, '', '/revisiones/abc?tab=2#fin')

    session.handleUnauthorized('t1')

    expect(session.isAuthenticated()).toBe(false)
    expect(session.getSessionNotice()).toEqual({ reason: 'unauthorized', returnTo: '/revisiones/abc?tab=2#fin' })
    // El aviso sobrevive a una recarga (sessionStorage) y no contiene el token.
    const stored = sessionStorage.getItem('notihouse-pal.session-notice')!
    expect(stored).not.toContain('t1')
    expect(sessionStorage.getItem('notihouse-pal.session')).toBeNull()
  })

  it('un 401 tardío de un token anterior NO cierra la sesión nueva', async () => {
    const { session } = await load()
    const f = vi.spyOn(globalThis, 'fetch')
    f.mockResolvedValueOnce(json(200, loginBody('viejo')))
    await session.login(credentials)
    f.mockResolvedValueOnce(json(200, loginBody('nuevo')))
    await session.login(credentials)

    session.handleUnauthorized('viejo') // respuesta tardía de la sesión anterior

    expect(session.isAuthenticated()).toBe(true)
    expect(session.getToken()).toBe('nuevo')
    expect(session.getSessionNotice()).toBeNull()
  })

  it('un 401 de una petición enviada sin token no cierra una sesión iniciada después', async () => {
    const { session } = await load()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1')))
    await session.login(credentials)
    session.handleUnauthorized(null)
    expect(session.isAuthenticated()).toBe(true)
  })

  it('integración con el cliente: dos peticiones del token viejo responden 401 después del nuevo login', async () => {
    const { session, client } = await load()
    const f = vi.spyOn(globalThis, 'fetch')
    f.mockResolvedValueOnce(json(200, loginBody('viejo')))
    await session.login(credentials)

    // Dos lecturas en vuelo con el token viejo; sus respuestas se resuelven manualmente.
    const late: Array<(r: Response) => void> = []
    f.mockImplementation(() => new Promise<Response>((resolve) => late.push(resolve)))
    const a = client.api('/alerts').catch((e: unknown) => e)
    const b = client.api('/dashboard').catch((e: unknown) => e)
    expect(late).toHaveLength(2)

    // La persona vuelve a entrar (nueva sesión) antes de que respondan.
    f.mockResolvedValueOnce(json(200, loginBody('nuevo')))
    await session.login(credentials)

    late[0]!(json(401, { message: 'Autenticación requerida' }))
    late[1]!(json(401, { message: 'Autenticación requerida' }))
    await Promise.all([a, b])

    expect(session.getToken()).toBe('nuevo')
    expect(session.isAuthenticated()).toBe(true)
  })

  it('el cierre voluntario no deja aviso y el login lo borra', async () => {
    const { session } = await load()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1')))
    await session.login(credentials)
    session.handleUnauthorized('t1')
    expect(session.getSessionNotice()).not.toBeNull()

    f.mockResolvedValue(json(200, loginBody('t2')))
    await session.login(credentials)
    expect(session.getSessionNotice()).toBeNull()

    session.logout()
    expect(session.getSessionNotice()).toBeNull()
    expect(sessionStorage.getItem('notihouse-pal.session-notice')).toBeNull()
  })
})

describe('sesión: vencimiento proactivo', () => {
  it('vence por sí sola a expiresAt, sin necesidad de una petición', async () => {
    const { session } = await load()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1', 7200)))
    await session.login(credentials)

    await vi.advanceTimersByTimeAsync(7200 * 1000 - 1000)
    expect(session.isAuthenticated()).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)

    expect(session.isAuthenticated()).toBe(false)
    expect(session.getSessionNotice()?.reason).toBe('expired')
  })

  it('al volver a la pestaña tras una suspensión, comprueba el vencimiento aunque el temporizador no corriera', async () => {
    const { session } = await load()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1', 7200)))
    await session.login(credentials)

    // Equipo suspendido: el reloj avanza pero los temporizadores no se ejecutan.
    vi.setSystemTime(new Date('2026-11-12T17:30:00Z'))
    expect(session.getSnapshot().token).toBe('t1')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(session.isAuthenticated()).toBe(false)
    expect(session.getSessionNotice()?.reason).toBe('expired')
  })

  it('una sesión restaurada ya vencida arranca cerrada y con aviso', async () => {
    sessionStorage.setItem(
      'notihouse-pal.session',
      JSON.stringify({ version: 1, token: 'caducado', user: { id: 'u1' }, expiresAt: Date.now() - 1000 }),
    )
    const { session } = await load()
    expect(session.isAuthenticated()).toBe(false)
    expect(session.getSessionNotice()?.reason).toBe('expired')
    expect(sessionStorage.getItem('notihouse-pal.session')).toBeNull()
  })

  it('msUntilExpiry refleja el tiempo restante', async () => {
    const { session } = await load()
    expect(session.msUntilExpiry()).toBeNull()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, loginBody('t1', 600)))
    await session.login(credentials)
    expect(session.msUntilExpiry()).toBe(600_000)
    vi.advanceTimersByTime(100_000)
    expect(session.msUntilExpiry()).toBe(500_000)
  })
})

describe('ruta de retorno segura', () => {
  it.each([
    ['/revisiones/1?tab=2#x', '/revisiones/1?tab=2#x'],
    ['/', '/'],
    ['//evil.example', null],
    ['https://evil.example', null],
    ['/login', null],
    ['/login?x=1', null],
    ['/a\\b', null],
    [undefined, null],
    [42, null],
  ])('safeReturnPath(%j) devuelve %j', async (input, expected) => {
    const { session } = await load()
    expect(session.safeReturnPath(input)).toBe(expected)
  })

  it('ignora la ruta de un aviso almacenado con datos manipulados', async () => {
    sessionStorage.setItem(
      'notihouse-pal.session-notice',
      JSON.stringify({ reason: 'expired', returnTo: '//evil.example' }),
    )
    const { session } = await load()
    expect(session.getSessionNotice()).toEqual({ reason: 'expired', returnTo: null })
  })
})

describe('descarga autenticada', () => {
  it('un 401 con el token vigente cierra la sesión; con un token anterior no', async () => {
    const { session } = await load()
    const f = vi.spyOn(globalThis, 'fetch')
    f.mockResolvedValueOnce(json(200, loginBody('viejo')))
    await session.login(credentials)
    const { downloadDocument } = await import('../../features/documents/api')

    // 1) La descarga sale con 'viejo', la persona inicia otra sesión y recién entonces llega el 401.
    let late!: (r: Response) => void
    f.mockImplementationOnce(() => new Promise<Response>((resolve) => (late = resolve)))
    const first = downloadDocument('d1', 'a.pdf').catch((e: unknown) => e)
    f.mockResolvedValueOnce(json(200, loginBody('nuevo')))
    await session.login(credentials)
    late(json(401, { message: 'Autenticación requerida' }))
    expect(await first).toMatchObject({ status: 401 })
    expect(session.isAuthenticated()).toBe(true)

    // 2) Con el token vigente, el 401 sí cierra la sesión.
    f.mockResolvedValueOnce(json(401, { message: 'Autenticación requerida' }))
    await expect(downloadDocument('d1', 'a.pdf')).rejects.toMatchObject({ status: 401 })
    expect(session.isAuthenticated()).toBe(false)
    expect(session.getSessionNotice()?.reason).toBe('unauthorized')
  })
})
