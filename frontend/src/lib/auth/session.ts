import { api, configureApiAuth } from '../api/client'
import type { AuthenticatedUser, LoginRequest, LoginResponse } from '../api/types'

/**
 * Módulo de sesión (§7, §11.4 de la guía). Reglas del backend que esto debe
 * respetar:
 * - El JWT dura 2 horas desde el login (`expiresIn`), SIN refresh token.
 * - No hay endpoint de logout en el servidor: "cerrar sesión" = descartar el
 *   token en el cliente.
 * - Un 401 en cualquier ruta (salvo el propio login) significa "sesión
 *   vencida o inválida": hay que limpiarla, nunca reintentarla. Solo cuenta si
 *   el token con el que se envió la petición sigue siendo el vigente (una
 *   respuesta tardía de una sesión anterior no cierra la nueva).
 * - La sesión vence de forma proactiva a `expiresAt` (temporizador), sin
 *   esperar a que una petición falle, y avisa unos minutos antes.
 *
 * Qué NO hace este módulo (por diseño, ver §11.4 y §7.6):
 * - No limpia la caché de TanStack Query. Eso lo hace la capa de React
 *   (ver useAuth.tsx), que es quien tiene el QueryClient, cada vez que esta
 *   sesión pasa a "no autenticada" o cambia de usuario.
 */

const STORAGE_KEY = 'notihouse-pal.session'

interface SessionState {
  token: string | null
  user: AuthenticatedUser | null
  /** Epoch ms en el que vence el token. */
  expiresAt: number | null
}

interface StoredSession extends SessionState {
  /** Para poder invalidar sesiones guardadas por una versión anterior del formato. */
  version: 1
}

function readPersisted(): SessionState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { token: null, user: null, expiresAt: null }
    const parsed = JSON.parse(raw) as StoredSession
    if (parsed.version !== 1) return { token: null, user: null, expiresAt: null }
    return { token: parsed.token, user: parsed.user, expiresAt: parsed.expiresAt }
  } catch {
    // Privado/bloqueado/corrupto: arrancar como si no hubiera sesión guardada.
    return { token: null, user: null, expiresAt: null }
  }
}

function writePersisted(state: SessionState): void {
  try {
    if (!state.token) {
      sessionStorage.removeItem(STORAGE_KEY)
      return
    }
    const toStore: StoredSession = { ...state, version: 1 }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(toStore))
  } catch {
    // Sin persistencia disponible: la sesión sigue viva en memoria para esta pestaña.
  }
}

/** Margen de la advertencia previa al vencimiento. */
export const EXPIRY_WARNING_MS = 5 * 60 * 1000

/** Por qué terminó la sesión sin que la persona lo pidiera. */
export type SessionEndReason = 'expired' | 'unauthorized'

/**
 * Aviso persistente para el login tras un cierre involuntario. NO contiene secretos
 * (ni token ni datos del usuario): solo el motivo y la ruta a la que volver.
 * Vive en sessionStorage (solo esta pestaña) y se borra al iniciar sesión o descartarlo.
 */
export interface SessionNotice {
  reason: SessionEndReason
  /** Ruta interna (con búsqueda y hash) a la que volver; siempre empieza por una sola "/". */
  returnTo: string | null
}

const NOTICE_KEY = 'notihouse-pal.session-notice'

/** Solo rutas internas: evita redirecciones abiertas desde un valor almacenado. */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('/') || value.startsWith('//') || value.includes(String.fromCharCode(92))) return null
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login#')) return null
  return value
}

function readNotice(): SessionNotice | null {
  try {
    const raw = sessionStorage.getItem(NOTICE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SessionNotice>
    if (parsed.reason !== 'expired' && parsed.reason !== 'unauthorized') return null
    return { reason: parsed.reason, returnTo: safeReturnPath(parsed.returnTo) }
  } catch {
    return null
  }
}

function writeNotice(notice: SessionNotice | null): void {
  try {
    if (!notice) sessionStorage.removeItem(NOTICE_KEY)
    else sessionStorage.setItem(NOTICE_KEY, JSON.stringify(notice))
  } catch {
    // Sin persistencia: el aviso se pierde al recargar el login, nada más.
  }
}

let notice: SessionNotice | null = readNotice()

export function getSessionNotice(): SessionNotice | null {
  return notice
}

export function clearSessionNotice(): void {
  if (notice === null) return
  notice = null
  writeNotice(null)
  emit()
}

function currentPath(): string | null {
  try {
    return safeReturnPath(window.location.pathname + window.location.search + window.location.hash)
  } catch {
    return null
  }
}

let state: SessionState = readPersisted()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: SessionState): void {
  state = next
  writePersisted(state)
  scheduleExpiry()
  emit()
}

// --- Vencimiento proactivo -------------------------------------------------

// setTimeout no admite más de 2^31-1 ms; el JWT dura 2 h, esto es solo un tope defensivo.
const MAX_TIMER_MS = 2_147_483_647
let expiryTimer: ReturnType<typeof setTimeout> | undefined

function scheduleExpiry(): void {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer)
  expiryTimer = undefined
  if (state.token === null || state.expiresAt === null) return
  const wait = Math.min(Math.max(state.expiresAt - Date.now(), 0), MAX_TIMER_MS)
  expiryTimer = setTimeout(checkExpiry, wait)
}

/**
 * Cierra la sesión si ya venció. Se ejecuta al llegar la hora y cuando la pestaña vuelve a
 * estar visible o enfocada (los temporizadores se retrasan con el equipo suspendido o la
 * pestaña en segundo plano).
 */
export function checkExpiry(): void {
  if (state.token !== null && isExpired()) endSession('expired')
  else if (state.token !== null) scheduleExpiry()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkExpiry()
  })
  window.addEventListener('focus', checkExpiry)
}

/** Termina la sesión sin que la persona lo haya pedido y deja el motivo para el login. */
function endSession(reason: SessionEndReason): void {
  const returnTo = currentPath()
  notice = { reason, returnTo }
  writeNotice(notice)
  setState({ token: null, user: null, expiresAt: null })
}

/** Milisegundos hasta el vencimiento (null sin sesión); 0 si ya venció. */
export function msUntilExpiry(): number | null {
  if (state.token === null || state.expiresAt === null) return null
  return Math.max(0, state.expiresAt - Date.now())
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSnapshot(): SessionState {
  return state
}

export function getToken(): string | null {
  return state.token
}

export function getUser(): AuthenticatedUser | null {
  return state.user
}

export function getExpiresAt(): number | null {
  return state.expiresAt
}

export function isExpired(): boolean {
  return state.expiresAt === null || Date.now() >= state.expiresAt
}

export function isAuthenticated(): boolean {
  return state.token !== null && !isExpired()
}

/** POST /auth/login real (§6.1, §8.1). Lanza ApiError en 400/401/429/503. */
export async function login(credentials: LoginRequest): Promise<AuthenticatedUser> {
  const response = await api<LoginResponse>('/auth/login', {
    method: 'POST',
    body: credentials,
    skipAuth: true, // el login nunca lleva Authorization ni dispara onUnauthorized
  })

  // Sesión nueva: el aviso de la anterior ya cumplió su función.
  notice = null
  writeNotice(null)
  setState({
    token: response.accessToken,
    user: response.user,
    expiresAt: Date.now() + response.expiresIn * 1000,
  })

  return response.user
}

/** "Cerrar sesión" = descartar el token localmente (el backend no tiene logout). Es voluntario: sin aviso. */
export function logout(): void {
  notice = null
  writeNotice(null)
  setState({ token: null, user: null, expiresAt: null })
}

/**
 * 401 recibido por una petición enviada con `sentToken`. Solo cierra la sesión si ese token es
 * el vigente: una respuesta tardía de una sesión anterior (o de una petición sin token) no
 * puede cerrar la sesión que la persona acaba de iniciar.
 */
export function handleUnauthorized(sentToken: string | null): void {
  if (sentToken === null || state.token === null || sentToken !== state.token) return
  endSession('unauthorized')
}

// Conecta este módulo con el cliente HTTP sin crear una dependencia circular
// (client.ts no importa este archivo; este archivo lo registra en él).
configureApiAuth({
  getToken,
  onUnauthorized: handleUnauthorized,
})

// Una sesión restaurada de sessionStorage también debe vencer a su hora (o ya haber vencido).
if (state.token !== null) checkExpiry()
