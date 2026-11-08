import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, type ReactNode } from 'react'
import { useAuth } from '../lib/auth/useAuth'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: false, // los reintentos de lectura se afinan por feature (§11.5/§11.8), no global
    },
    mutations: {
      retry: false, // NUNCA reintentar escrituras en automático (§11.9)
    },
  },
})

/**
 * Limpia toda la caché de datos cuando la sesión pasa a "sin usuario" o
 * cuando cambia de usuario (login manual, logout manual o logout automático
 * por un 401 — §7.5, §7.6, §11.4). Vive separado de useAuth para cubrir
 * ambos caminos con una sola regla.
 */
function AuthCacheSync() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const previousUserId = useRef<string | null>(null)

  useEffect(() => {
    const currentUserId = user?.id ?? null
    if (previousUserId.current !== currentUserId) {
      queryClient.clear()
      previousUserId.current = currentUserId
    }
  }, [user, queryClient])

  return null
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthCacheSync />
      {children}
    </QueryClientProvider>
  )
}
