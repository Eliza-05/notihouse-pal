import { useAuth } from '../../lib/auth/useAuth'

/**
 * Placeholder de sanity-check: solo demuestra que la sesión y las rutas
 * protegidas funcionan de punta a punta. El Resumen real (GET /dashboard/summary
 * + GET /attention, campana de notificaciones, KPIs, §8.2 y §8.7) se construye
 * en el paso 4 del plan, una vez resuelta la identidad visual.
 */
export function DashboardPage() {
  const { user, logout } = useAuth()

  return (
    <main className="app-shell">
      <h1>Hola, {user?.displayName ?? user?.email}</h1>
      <p className="app-shell__status">Sesión activa — aquí vivirá el Resumen real.</p>
      <button type="button" onClick={logout}>
        Cerrar sesión
      </button>
    </main>
  )
}
