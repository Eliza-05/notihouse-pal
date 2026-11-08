import { api, configureApiAuth } from '../api/client'
import type { AuthenticatedUser, LoginRequest, LoginResponse } from '../api/types'

/**
 * Módulo de sesión (§7, §11.4 de la guía). Reglas del backend que esto debe
 * respetar:
 * - El JWT dura 30 minutos desde el login (`expiresIn`), SIN refresh token.
 * - No hay endpoint de logout en el servidor: "cerrar sesión" = descartar el
 *   token en el cliente.
 * - Un 401 en cualquier ruta (salvo el propio login) significa "sesión
 *   vencida o inválida": hay que limpiarla, nunca reintentarla.
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

let state: SessionState = readPersisted()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: SessionState): void {
  state = next
  writePersisted(state)
  emit()
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

  setState({
    token: response.accessToken,
    user: response.user,
    expiresAt: Date.now() + response.expiresIn * 1000,
  })

  return response.user
}

/** "Cerrar sesión" = descartar el token localmente (el backend no tiene logout). */
export function logout(): void {
  setState({ token: null, user: null, expiresAt: null })
}

// Conecta este módulo con el cliente HTTP sin crear una dependencia circular
// (client.ts no importa este archivo; este archivo lo registra en él).
configureApiAuth({
  getToken,
  onUnauthorized: logout,
})
