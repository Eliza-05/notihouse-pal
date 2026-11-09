import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, configureApiAuth } from './client'
import { ApiError } from './errors'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

afterEach(() => {
  vi.restoreAllMocks()
  configureApiAuth({ getToken: () => null, onUnauthorized: () => {} })
})

describe('cliente de API', () => {
  it('adjunta el JWT y serializa JSON', async () => {
    configureApiAuth({ getToken: () => 'jwt-de-prueba', onUnauthorized: () => {} })
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { ok: true }))
    await api('/properties', { method: 'POST', body: { name: 'Casa' } })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('http://localhost:3999/api/v1/properties')
    const h = new Headers(init!.headers)
    expect(h.get('Authorization')).toBe('Bearer jwt-de-prueba')
    expect(h.get('Content-Type')).toBe('application/json')
    expect(init!.body).toBe('{"name":"Casa"}')
  })

  it('no fija Content-Type en multipart (lo pone el navegador con el boundary)', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, {}))
    const form = new FormData()
    form.append('file', new Blob(['x']), 'a.pdf')
    await api('/ingestions/documents', { method: 'POST', body: form })
    const init = f.mock.calls[0]![1]!
    expect(init.body).toBe(form)
    expect(new Headers(init.headers).has('Content-Type')).toBe(false)
  })

  it('skipAuth no envía Authorization ni dispara onUnauthorized (login)', async () => {
    const onUnauthorized = vi.fn()
    configureApiAuth({ getToken: () => 'x', onUnauthorized })
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(401, { message: 'Credenciales inválidas' }))
    await expect(api('/auth/login', { method: 'POST', body: {}, skipAuth: true })).rejects.toBeInstanceOf(ApiError)
    expect(new Headers(f.mock.calls[0]![1]!.headers).has('Authorization')).toBe(false)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('un 401 autenticado limpia la sesión y lanza ApiError', async () => {
    const onUnauthorized = vi.fn()
    configureApiAuth({ getToken: () => 'vencido', onUnauthorized })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(401, { message: 'Unauthorized' }))
    await expect(api('/obligations')).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('convierte errores en ApiError con mensajes y correlationId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(400, { message: ['dueDay debe ser menor o igual a 31', 'concept no puede estar vacío'] }, { 'x-correlation-id': 'abc-123' }))
    const err = await api('/obligations', { method: 'POST', body: {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
    expect((err as ApiError).messages).toHaveLength(2)
    expect((err as ApiError).correlationId).toBe('abc-123')
  })

  it('tolera errores sin cuerpo JSON (p. ej. 503 del proxy)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 503, statusText: 'Service Unavailable' }))
    await expect(api('/health')).rejects.toMatchObject({ status: 503, messages: ['Service Unavailable'] })
  })

  it('devuelve undefined con cuerpos vacíos (204)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await expect(api('/alerts/1/read', { method: 'POST' })).resolves.toBeUndefined()
  })
})
