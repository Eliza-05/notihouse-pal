import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'
import { ApiError, RequestTimeoutError } from './errors'
import { friendlyError, isFriendlyMessage } from './messages'

const err = (status: number, ...messages: string[]) => new ApiError(status, messages, 'corr-12345678-xxxx')

describe('mensajes de error en español, sin tecnicismos', () => {
  it('red caída: lo explica sin decir «Failed to fetch»', () => {
    const msg = friendlyError(new TypeError('Failed to fetch'))
    expect(msg).toMatch(/No pudimos conectar con el servicio/)
    expect(msg).not.toMatch(/fetch|Mis solicitudes/i) // una lectura no pudo haber guardado nada
    // Una escritura sin respuesta pudo haberse registrado: se pide comprobarlo antes de repetir.
    expect(friendlyError(new TypeError('Failed to fetch'), 'upload')).toMatch(/Mis solicitudes/)
  })

  it('tiempo de espera agotado: distinto de una red caída', () => {
    expect(friendlyError(new RequestTimeoutError())).toMatch(/tardando más de lo normal/)
    // Una escritura que agota el tiempo pudo haberse registrado: no se invita a reenviar a ciegas.
    expect(friendlyError(new RequestTimeoutError(true))).toMatch(/sí se haya registrado/)
  })

  it('409 por duplicado conserva la frase clara del backend', () => {
    const m = friendlyError(err(409, 'Ya existe una obligación con el mismo proveedor y concepto; aplica un período sobre ella'), 'apply')
    expect(m).toMatch(/Ya existe una obligación/)
  })

  it('409 con texto técnico se sustituye por una explicación accionable', () => {
    const m = friendlyError(err(409, 'Request failed with status code 409'), 'save')
    expect(m).not.toMatch(/status code/)
    expect(m).toMatch(/Actualiza la pantalla/)
  })

  it('415 por PDF con contenido activo explica cómo regenerarlo', () => {
    const m = friendlyError(err(415, 'El PDF contiene contenido activo (JavaScript, acciones o archivos incrustados) y no se admite'), 'upload')
    expect(m).toMatch(/elementos interactivos|archivos incrustados/)
    expect(m).toMatch(/Guardar como PDF/)
    expect(m).not.toMatch(/JavaScript/)
  })

  it('415 genérico pide una factura en PDF', () => {
    expect(friendlyError(err(415, 'Unsupported Media Type'), 'upload')).toMatch(/PDF/)
  })

  it('413, 429, 503 y 5xx tienen su propio mensaje', () => {
    expect(friendlyError(err(413, 'Payload Too Large'))).toMatch(/demasiado grande/)
    expect(friendlyError(err(429, 'Too Many Requests'))).toMatch(/Espera un momento/)
    expect(friendlyError(err(503, 'Service Unavailable'))).toMatch(/iniciando|no está disponible/)
    expect(friendlyError(err(500, 'Internal Server Error'))).toMatch(/El servidor tuvo un problema/)
    expect(friendlyError(err(502, 'Bad Gateway'))).not.toMatch(/Bad Gateway/)
  })

  it('401: en login es credenciales incorrectas; fuera, sesión vencida', () => {
    expect(friendlyError(err(401, 'Unauthorized'), 'login')).toMatch(/correo o la contraseña/)
    expect(friendlyError(err(401, 'Unauthorized'))).toMatch(/sesión venció/)
  })

  it('403 y 404 con texto técnico → mensaje claro', () => {
    expect(friendlyError(err(403, 'Forbidden'))).toMatch(/No tienes permiso/)
    expect(friendlyError(err(404, 'Not Found'))).toMatch(/No encontramos/)
  })

  it('400 conserva una validación en español y reemplaza una técnica', () => {
    expect(friendlyError(err(400, 'El vencimiento no puede ser anterior al inicio'), 'save')).toBe('El vencimiento no puede ser anterior al inicio')
    const m = friendlyError(err(400, 'property ownerId should not exist'), 'save')
    expect(m).not.toMatch(/ownerId/)
    expect(m).toMatch(/Tus datos no se guardaron/)
  })

  it('errores desconocidos no exponen nada interno', () => {
    expect(friendlyError(new Error('boom {"x":1}'))).toMatch(/error inesperado/)
    expect(friendlyError('algo')).toMatch(/error inesperado/)
  })

  it('isFriendlyMessage distingue español claro de texto técnico o en inglés', () => {
    expect(isFriendlyMessage('Esta factura ya fue registrada.')).toBe(true)
    expect(isFriendlyMessage('Internal Server Error')).toBe(false)
    expect(isFriendlyMessage('{"message":"x"}')).toBe(false)
    expect(isFriendlyMessage('')).toBe(false)
  })
})

describe('timeout del cliente de API', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('una petición que no responde lanza RequestTimeoutError (no un error de red)', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )
    const p = api('/dashboard/summary', { timeoutMs: 5_000 })
    const assertion = expect(p).rejects.toBeInstanceOf(RequestTimeoutError)
    await vi.advanceTimersByTimeAsync(5_100)
    await assertion
  })

  it('si la cancela quien llama (React Query) no se confunde con un timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )
    const ctrl = new AbortController()
    const p = api('/x', { signal: ctrl.signal, timeoutMs: 60_000 })
    ctrl.abort()
    await expect(p).rejects.not.toBeInstanceOf(RequestTimeoutError)
  })
})
