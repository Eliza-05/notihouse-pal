import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import './Feedback.css'

/**
 * Indicador circular para operaciones en curso. Decorativo: el estado se anuncia
 * con texto (aria-busy / role="status" del contenedor), no con el giro.
 */
export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <span className={`nh-spin ${className}`.trim()} style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * Botón con estado de carga. Mientras `loading`:
 *  - queda deshabilitado (no admite doble envío),
 *  - muestra spinner + `loadingText`,
 *  - conserva el ancho para que no "salte" la interfaz,
 *  - expone `aria-busy`.
 */
export function LoadingButton({
  loading = false,
  loadingText,
  children,
  disabled,
  className = 'btn btn-primary',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; loadingText?: string; children: ReactNode }) {
  return (
    <button
      {...rest}
      type={type}
      className={`${className} nh-loading-btn${loading ? ' is-loading' : ''}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <Spinner size={14} />}
      <span>{loading ? (loadingText ?? children) : children}</span>
    </button>
  )
}

/** Bloque de esqueleto: reserva espacio con la forma del contenido real para evitar saltos visuales. */
export function Skeleton({ width = '100%', height = 14, radius = 8, style }: { width?: number | string; height?: number | string; radius?: number; style?: CSSProperties }) {
  return <span className="nh-skeleton" style={{ width, height, borderRadius: radius, ...style }} aria-hidden="true" />
}

/**
 * Contenedor de un grupo de esqueletos. Anuncia UNA vez «Cargando…» a lectores de
 * pantalla (role="status" + texto oculto) y marca la región como ocupada.
 */
export function SkeletonRegion({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className} role="status" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {children}
    </div>
  )
}

/** Filas de lista (icono + dos líneas + importe), como las de la Bandeja y el Resumen. */
export function SkeletonRows({ rows = 4, label = 'Cargando…' }: { rows?: number; label?: string }) {
  return (
    <SkeletonRegion label={label} className="nh-skel-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div className="nh-skel-row" key={i}>
          <Skeleton width={36} height={36} radius={12} />
          <div className="nh-skel-lines">
            <Skeleton width="55%" height={13} />
            <Skeleton width="35%" height={11} />
          </div>
          <Skeleton width={64} height={22} radius={999} />
        </div>
      ))}
    </SkeletonRegion>
  )
}

/** Tabla genérica: encabezado + filas. */
export function SkeletonTable({ rows = 5, cols = 4, label = 'Cargando…' }: { rows?: number; cols?: number; label?: string }) {
  return (
    <SkeletonRegion label={label} className="card nh-skel-table">
      <div className="nh-skel-tr nh-skel-head" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} width="60%" height={11} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="nh-skel-tr" key={r} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} width={c === 0 ? '80%' : '55%'} height={13} />
          ))}
        </div>
      ))}
    </SkeletonRegion>
  )
}

/** Tarjetas de cifras (Resumen). */
export function SkeletonStats({ count = 6, label = 'Cargando resumen…' }: { count?: number; label?: string }) {
  return (
    <SkeletonRegion label={label} className="kpi-grid">
      {Array.from({ length: count }, (_, i) => (
        <div className="glass kpi nh-skel-stat" key={i}>
          <Skeleton width="45%" height={11} />
          <Skeleton width="30%" height={30} radius={10} />
          <Skeleton width="70%" height={11} />
        </div>
      ))}
    </SkeletonRegion>
  )
}

/** Tarjeta de detalle: título + varias líneas. */
export function SkeletonCard({ lines = 4, label = 'Cargando…' }: { lines?: number; label?: string }) {
  return (
    <SkeletonRegion label={label} className="card nh-skel-card">
      <Skeleton width="40%" height={20} radius={8} />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i % 2 ? '70%' : '90%'} height={13} />
      ))}
    </SkeletonRegion>
  )
}
