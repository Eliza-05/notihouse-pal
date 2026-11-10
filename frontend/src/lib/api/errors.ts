import type { ApiErrorBody } from './types'

/**
 * Error tipado para cualquier respuesta no exitosa de la API.
 * Ver GUIA_FRONTEND_NOTIHOUSE_PAL.md §11.6 para la clasificación completa
 * por código de estado (400/401/404/409/429/503/5xx) y qué hacer con cada una;
 * esa lógica de presentación vive en cada feature, no aquí.
 */
export class ApiError extends Error {
  readonly status: number
  readonly messages: string[]
  readonly correlationId?: string

  constructor(status: number, messages: string[], correlationId?: string) {
    super(messages.join('\n'))
    this.name = 'ApiError'
    this.status = status
    this.messages = messages
    this.correlationId = correlationId
  }

  static async from(res: Response): Promise<ApiError> {
    let body: ApiErrorBody | null = null
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      // Respuesta sin cuerpo JSON (p. ej. un 503 del proxy de Render): se ignora.
    }

    const m = body?.message
    // Un 5xx sin mensaje propio (o el genérico en inglés de Nest/proxy) se muestra en español.
    const genericServer = 'El servidor tuvo un problema. Inténtalo de nuevo en unos minutos.'
    const isEnglishGeneric = typeof m === 'string' && /^(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)$/i.test(m)
    const messages =
      res.status >= 500 && (!m || isEnglishGeneric)
        ? [genericServer]
        : Array.isArray(m)
          ? m
          : m
            ? [m]
            : [res.statusText || `Error ${res.status}`]

    return new ApiError(res.status, messages, res.headers.get('x-correlation-id') ?? undefined)
  }
}

/**
 * `fetch` lanza un TypeError cuando no hubo respuesta en absoluto
 * (red caída, CORS bloqueado, el proxy de Render cortó la conexión, etc.).
 * Distinguirlo de un error HTTP normal es clave para no decir "sin conexión"
 * cuando en realidad el servidor sí respondió con un 4xx/5xx (§11.6, §11.8).
 */
export function isNetworkError(e: unknown): e is TypeError {
  return e instanceof TypeError
}
