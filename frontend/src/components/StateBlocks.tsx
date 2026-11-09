import type { ReactNode } from 'react'
import { ApiError, isNetworkError } from '../lib/api/errors'

/** Indicador de carga que respeta la forma del contenido (§8, nunca pantalla en blanco). */
export function LoadingBlock({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="state-block" role="status">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  )
}

/** Estado vacío: explica la sección y ofrece la acción siguiente (§8). */
export function EmptyBlock({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="state-block">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div style={{ marginTop: '0.9rem' }}>{action}</div>}
    </div>
  )
}

/** Mensaje de error en lenguaje claro + Reintentar + id de correlación copiable (§8). */
export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = describeError(error)
  const correlationId = error instanceof ApiError ? error.correlationId : undefined
  return (
    <div className="state-block" role="alert">
      <h3>No pudimos cargar esto</h3>
      <p>{message}</p>
      {correlationId && <p className="text-muted">Id para soporte: {correlationId}</p>}
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry} style={{ marginTop: '0.7rem' }}>
          Reintentar
        </button>
      )}
    </div>
  )
}

export function describeError(error: unknown): string {
  if (isNetworkError(error)) return 'No pudimos conectar con el servidor. Verifica tu conexión e intenta de nuevo.'
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.'
    if (error.status === 503) return 'El servicio está iniciando o no disponible por ahora. Reintenta en unos segundos.'
    if (error.status === 429) return 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.'
    return error.messages.join(' ')
  }
  return 'Ocurrió un error inesperado.'
}
