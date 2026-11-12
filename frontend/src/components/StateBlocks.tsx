import type { ReactNode } from 'react'
import { ApiError } from '../lib/api/errors'
import { friendlyError } from '../lib/api/messages'

/** Indicador de carga que respeta la forma del contenido (§8, nunca pantalla en blanco). */
export function LoadingBlock({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="state-block" role="status" aria-busy="true">
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
      {correlationId && <p className="text-muted" style={{ fontSize: '0.78rem' }}>Código para soporte: {correlationId.slice(0, 8)}</p>}
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry} style={{ marginTop: '0.7rem' }}>
          Reintentar
        </button>
      )}
    </div>
  )
}

/** Mensaje en lenguaje claro para cualquier error (ver lib/api/messages). */
export function describeError(error: unknown): string {
  return friendlyError(error, 'load')
}
