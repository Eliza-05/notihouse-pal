import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { LoginPage } from '../features/auth/LoginPage'
import { RootRoute } from './RootRoute'

/**
 * Rutas propias del frontend (no existen como tales en el backend, §8).
 * Se amplía a medida que se construya cada módulo (inmuebles, obligaciones,
 * arriendos, contratos, alertas, documentos, voz, casos, revisiones HITL —
 * ver la estructura de carpetas del plan, §5). "/" no usa RequireAuth: ahora
 * es pública y decide ella misma qué mostrar (ver RootRoute.tsx).
 */
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <RootRoute /> },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
