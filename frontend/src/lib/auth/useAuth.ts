import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
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

/**
 * Minutos que le quedan a la sesión cuando faltan menos de `EXPIRY_WARNING_MS`; `null` si
 * aún hay margen o no hay sesión. Solo programa temporizadores (nunca lee ni guarda
 * secretos) y se actualiza cada 15 s dentro de la ventana de aviso.
 */
export function useExpiryWarning(): number | null {
  const { expiresAt } = useAuth()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (expiresAt === null) return
    const warnIn = expiresAt - session.EXPIRY_WARNING_MS - Date.now()
    let tick: ReturnType<typeof setInterval> | undefined
    const start = () => {
      setNow(Date.now())
      tick = setInterval(() => setNow(Date.now()), 15_000)
    }
    const timer = warnIn > 0 ? setTimeout(start, warnIn) : undefined
    if (warnIn <= 0) start()
    return () => {
      if (timer) clearTimeout(timer)
      if (tick) clearInterval(tick)
    }
  }, [expiresAt])

  if (expiresAt === null) return null
  const left = expiresAt - now
  if (left <= 0 || left > session.EXPIRY_WARNING_MS) return null
  return Math.max(1, Math.ceil(left / 60_000))
}
