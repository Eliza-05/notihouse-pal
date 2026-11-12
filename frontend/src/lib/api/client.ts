import { ApiError, RequestTimeoutError } from './errors'

const BASE_URL = import.meta.env.VITE_API_BASE_URL

if (!BASE_URL || !(BASE_URL.startsWith('https://') || BASE_URL.startsWith('http://localhost'))) {
  // Falla rápido y en voz alta: sin esta variable nada en la app puede funcionar.
  // Ver GUIA_FRONTEND_NOTIHOUSE_PAL.md §11.2 y §12.3.
  // eslint-disable-next-line no-console
  console.error(
    '[config] VITE_API_BASE_URL no está definida o no es una URL válida. ' +
      'Crea frontend/.env.local a partir de .env.example.',
  )
}

/**
 * Puntos de integración con la sesión (lib/auth/session.ts), inyectados en el
 * arranque de la app para evitar una dependencia circular entre el cliente de
 * API y el módulo de sesión (el módulo de sesión también necesita llamar a
 * la API para hacer login).
 */
interface AuthHooks {
  getToken: () => string | null
  /** Se invoca ante cualquier 401 (salvo en el propio login): limpia la sesión. */
  onUnauthorized: () => void
}

let authHooks: AuthHooks = {
  getToken: () => null,
  onUnauthorized: () => {},
}

export function configureApiAuth(hooks: AuthHooks): void {
  authHooks = hooks
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  /** FormData para multipart, string para un body ya serializado, o cualquier objeto para JSON. */
  body?: BodyInit | object | null
  /** true = no envía Authorization ni dispara onUnauthorized en un 401 (solo /auth/login y /health*). */
  skipAuth?: boolean
  /**
   * Tiempo máximo de espera en ms. Por defecto 60 s (Render puede tardar ~50 s en despertar);
   * `0` lo desactiva. Al vencer lanza `RequestTimeoutError` (no es un error de red).
   */
  timeoutMs?: number
}

export const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Cliente HTTP único para toda la app. Centraliza:
 * - Adjuntar `Authorization: Bearer <token>` (§7.3).
 * - Serializar JSON automáticamente (deja pasar FormData intacto para multipart, §11.7).
 * - Convertir cualquier respuesta no exitosa en un ApiError tipado (§11.6).
 * - Delegar el manejo de 401 a la sesión (§7.4): un único punto de verdad.
 *
 * Los reintentos (lecturas sí, escrituras nunca) y el manejo de 503/arranque
 * en frío de Render (§11.8) se implementan en los hooks de TanStack Query de
 * cada feature (§11.5), no aquí: este cliente hace una sola petición por llamada.
 */
export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { body, skipAuth, headers, timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = options

  const finalHeaders = new Headers(headers)
  let finalBody: BodyInit | null | undefined

  if (body instanceof FormData || body === undefined || body === null || typeof body === 'string') {
    // FormData: NO fijar Content-Type a mano (el navegador pone el boundary correcto, §11.7).
    finalBody = body as BodyInit | null | undefined
  } else {
    finalHeaders.set('Content-Type', 'application/json')
    finalBody = JSON.stringify(body)
  }

  if (!skipAuth) {
    const token = authHooks.getToken()
    if (token) finalHeaders.set('Authorization', `Bearer ${token}`)
  }

  // Un solo AbortController: lo cancela el llamador (React Query al desmontar) o nuestro temporizador.
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs) : undefined

  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: finalHeaders,
      body: finalBody,
    })
  } catch (e) {
    if (timedOut) throw new RequestTimeoutError(!['GET', 'HEAD', undefined].includes(rest.method?.toUpperCase()))
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }

  if (res.status === 401 && !skipAuth) {
    authHooks.onUnauthorized()
  }

  if (!res.ok) {
    throw await ApiError.from(res)
  }

  // 204 / cuerpos vacíos (poco frecuentes en esta API, pero no asumir JSON siempre).
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}
