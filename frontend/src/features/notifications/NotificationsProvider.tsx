import { createContext, useContext, type ReactNode } from 'react'
import { useNotifications, type NotificationsState } from './hooks'

const Ctx = createContext<NotificationsState | null>(null)

/**
 * Una sola instancia de las consultas de notificaciones para toda la pantalla: la campana y
 * los avisos flotantes leen el mismo estado, así que el polling no se duplica.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const state = useNotifications()
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>
}

export function useNotificationsState(): NotificationsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useNotificationsState debe usarse dentro de <NotificationsProvider>')
  return ctx
}
