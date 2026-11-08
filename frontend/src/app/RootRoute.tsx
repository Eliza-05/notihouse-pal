import { AppShell } from '../components/AppShell'
import { LandingPage } from '../features/landing/LandingPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { useAuth } from '../lib/auth/useAuth'

/**
 * "/" hace doble función a propósito, en vez de introducir una ruta nueva
 * como "/dashboard": sin sesión muestra la Landing pública; con sesión
 * activa, el Resumen. Es el cambio mínimo posible al enrutamiento existente
 * para incorporar una landing pública (antes "/" solo existía protegida).
 */
export function RootRoute() {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <LandingPage />
  return (
    <AppShell>
      <DashboardPage />
    </AppShell>
  )
}
