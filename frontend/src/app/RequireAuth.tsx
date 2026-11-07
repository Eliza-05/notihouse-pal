import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth/useAuth'

/**
 * Ruta protegida (§7.4, §11.4): sin sesión válida, redirige a /login y
 * conserva la ruta original en el estado de navegación para volver a ella
 * tras iniciar sesión (requisito de §15.1: "vuelven a la ruta original tras entrar").
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return <>{children}</>
}
