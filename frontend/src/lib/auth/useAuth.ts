import { useCallback, useSyncExternalStore } from 'react'
import * as session from './session'
import type { LoginRequest } from '../api/types'

/**
 * Hook de lectura/acción sobre la sesión (§7, §11.4). No gestiona la caché de
 * TanStack Query: eso lo hace `AuthCacheSync`, montado una sola vez en
 * app/providers.tsx, para cubrir tanto el logout manual como el automático
 * (un 401 en cualquier petición dispara `session.logout()` directamente,
 * sin pasar por este hook).
 */
export function useAuth() {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)

  const login = useCallback((credentials: LoginRequest) => session.login(credentials), [])
  const logout = useCallback(() => session.logout(), [])

  return {
    user: snapshot.user,
    expiresAt: snapshot.expiresAt,
    isAuthenticated: snapshot.token !== null && !session.isExpired(),
    login,
    logout,
  }
}
