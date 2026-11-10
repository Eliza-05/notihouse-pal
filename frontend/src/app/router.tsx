import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { LoginPage } from '../features/auth/LoginPage'
import { PropertiesPage } from '../features/properties/PropertiesPage'
import { PropertyDetailPage } from '../features/properties/PropertyDetailPage'
import { ObligationsPage } from '../features/obligations/ObligationsPage'
import { ObligationDetailPage } from '../features/obligations/ObligationDetailPage'
import { RentalsPage } from '../features/rentals/RentalsPage'
import { RentalDetailPage } from '../features/rentals/RentalDetailPage'
import { ContractsPage } from '../features/contracts/ContractsPage'
import { AlertsPage } from '../features/alerts/AlertsPage'
import { AttentionPage } from '../features/attention/AttentionPage'
import { DocumentsPage } from '../features/documents/DocumentsPage'
import { VoicePage } from '../features/voice/VoicePage'
import { CasesPage } from '../features/cases/CasesPage'
import { CaseDetailPage } from '../features/cases/CaseDetailPage'
import { HitlDetailPage } from '../features/cases/HitlDetailPage'
import { AssistantPage } from '../features/assistant/AssistantPage'
import { RequireAuth } from './RequireAuth'
import { RootRoute } from './RootRoute'
import { NotFoundPage } from './NotFoundPage'

function protect(element: React.ReactNode) {
  return (
    <RequireAuth>
      <AppShell>{element}</AppShell>
    </RequireAuth>
  )
}

/**
 * Rutas propias del frontend (no existen como tales en el backend, §8).
 * "/" no usa RequireAuth: decide ella misma qué mostrar (ver RootRoute.tsx).
 */
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <RootRoute /> },
  { path: '/inmuebles', element: protect(<PropertiesPage />) },
  { path: '/inmuebles/:id', element: protect(<PropertyDetailPage />) },
  { path: '/obligaciones', element: protect(<ObligationsPage />) },
  { path: '/obligaciones/:id', element: protect(<ObligationDetailPage />) },
  { path: '/arriendos', element: protect(<RentalsPage />) },
  { path: '/arriendos/:id', element: protect(<RentalDetailPage />) },
  { path: '/contratos', element: protect(<ContractsPage />) },
  { path: '/alertas', element: protect(<AlertsPage />) },
  { path: '/atencion', element: protect(<AttentionPage />) },
  { path: '/documentos', element: protect(<DocumentsPage />) },
  { path: '/voz', element: protect(<VoicePage />) },
  { path: '/casos', element: protect(<CasesPage />) },
  { path: '/casos/:id', element: protect(<CaseDetailPage />) },
  { path: '/revisiones/:id', element: protect(<HitlDetailPage />) },
  { path: '/asistente', element: protect(<AssistantPage />) },
  { path: '*', element: <NotFoundPage /> },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
