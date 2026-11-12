import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BellRing, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import './Toasts.css'

/**
 * Avisos flotantes dentro de la aplicación (NO son notificaciones push del sistema).
 *
 *  - `success` / `info`: feedback de una acción ("Cambios guardados"). Discretos, breves,
 *    y los repetidos se fusionan en uno solo (no se acumulan).
 *  - `error`: permanece más tiempo y se anuncia como alerta.
 *  - `notice`: aviso relevante (p. ej. "Tienes una factura por revisar") con acción para abrirlo.
 *
 * Los avisos relevantes que deben persistir viven en la campana (features/notifications);
 * el toast solo avisa en el momento. Cada toast tiene un `id` estable para no duplicarse.
 */

export type ToastKind = 'success' | 'info' | 'error' | 'notice'

export interface ToastInput {
  /** Identificador estable: si ya existe un toast con este id, se actualiza en vez de duplicarse. */
  id?: string
  kind: ToastKind
  title?: string
  message: string
  /** Ruta interna a la que lleva la acción. */
  to?: string
  actionLabel?: string
  /** Milisegundos hasta cerrarse solo; 0 = no se cierra solo. */
  durationMs?: number
}

interface ToastItem extends ToastInput {
  id: string
  leaving: boolean
}

interface ToastApi {
  success: (message: string) => void
  info: (message: string) => void
  error: (message: string, title?: string) => void
  notify: (toast: Omit<ToastInput, 'kind'>) => void
  dismiss: (id: string) => void
  clear: () => void
}

const DEFAULT_MS: Record<ToastKind, number> = { success: 4000, info: 5000, notice: 10000, error: 9000 }
const MAX_VISIBLE = 3
const EXIT_MS = 200

const ToastContext = createContext<{ api: ToastApi; toasts: ToastItem[] } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) clearTimeout(t)
      map.clear()
    }
  }, [])

  const remove = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id))
    const handle = timers.current.get(id)
    if (handle) clearTimeout(handle)
    timers.current.delete(id)
  }, [])

  const dismiss = useCallback(
    (id: string) => {
      setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
      const prev = timers.current.get(id)
      if (prev) clearTimeout(prev)
      timers.current.set(id, setTimeout(() => remove(id), EXIT_MS))
    },
    [remove],
  )

  const show = useCallback((input: ToastInput) => {
    const id = input.id ?? `${input.kind}:${input.title ?? ''}:${input.message}`
    setToasts((list) => {
      const rest = list.filter((t) => t.id !== id)
      const next = [...rest, { ...input, id, leaving: false }]
      // Máximo visible: se descartan los más antiguos que no sean errores.
      while (next.length > MAX_VISIBLE) {
        const idx = next.findIndex((t) => t.kind !== 'error')
        if (idx < 0) break
        next.splice(idx, 1)
      }
      return next
    })
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => show({ kind: 'success', message }),
      info: (message) => show({ kind: 'info', message }),
      error: (message, title) => show({ kind: 'error', message, title }),
      notify: (toast) => show({ ...toast, kind: 'notice' }),
      dismiss,
      clear: () => {
        for (const t of timers.current.values()) clearTimeout(t)
        timers.current.clear()
        setToasts([])
      },
    }),
    [show, dismiss],
  )

  const value = useMemo(() => ({ api, toasts }), [api, toasts])
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast debe usarse dentro de <ToastProvider>')
  return ctx.api
}

const ICON: Record<ToastKind, LucideIcon> = { success: CircleCheck, info: Info, error: TriangleAlert, notice: BellRing }

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false)
  const Icon = ICON[toast.kind]
  const duration = toast.durationMs ?? DEFAULT_MS[toast.kind]

  useEffect(() => {
    if (paused || duration === 0 || toast.leaving) return
    const handle = setTimeout(() => onDismiss(toast.id), duration)
    return () => clearTimeout(handle)
  }, [paused, duration, toast.id, toast.leaving, onDismiss])

  return (
    <div
      className={`toast toast-${toast.kind}${toast.leaving ? ' is-leaving' : ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <div className="toast-body">
        {toast.title && <p className="toast-title">{toast.title}</p>}
        <p className="toast-msg">{toast.message}</p>
        {toast.to && toast.actionLabel && (
          <Link to={toast.to} className="toast-action" onClick={() => onDismiss(toast.id)}>
            {toast.actionLabel}
          </Link>
        )}
      </div>
      <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Cerrar aviso">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * Contenedor fijo en la esquina. Dos regiones: una cortés (éxitos y avisos) y una de alerta
 * (errores), para que un lector de pantalla anuncie cada tipo con la prioridad adecuada.
 * Debe renderizarse dentro del Router (los avisos pueden enlazar a una pantalla).
 */
export function ToastViewport() {
  const ctx = useContext(ToastContext)
  if (!ctx) return null
  const { toasts, api } = ctx
  const errors = toasts.filter((t) => t.kind === 'error')
  const others = toasts.filter((t) => t.kind !== 'error')
  return (
    <div className="toast-viewport">
      <div role="status" aria-live="polite" aria-atomic="false" className="toast-region">
        {others.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={api.dismiss} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="false" className="toast-region">
        {errors.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={api.dismiss} />
        ))}
      </div>
    </div>
  )
}
