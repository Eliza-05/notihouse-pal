import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { LoginPage } from '../features/auth/LoginPage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { RequireAuth } from './RequireAuth'

/**
 * Rutas propias del frontend (no existen como tales en el backend, §8).
 * Se amplía a medida que se construya cada módulo (inmuebles, obligaciones,
 * arriendos, contratos, alertas, documentos, voz, casos, revisiones HITL —
 * ver la estructura de carpetas del plan, §5).
 */
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <RequireAuth><DashboardPage /></RequireAuth> },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
