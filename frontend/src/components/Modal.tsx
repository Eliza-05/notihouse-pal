import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './Modal.css'

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Al cerrar, el foco vuelve al control que abrió el diálogo (accesibilidad por teclado).
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  useEffect(() => {
    ref.current?.focus()
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Portal al contenedor .app-shell: fuera de cualquier .card (cuyo
  // backdrop-filter atraparía el position:fixed) pero dentro del ámbito
  // de los tokens visuales.
  const host = document.querySelector('.app-shell') ?? document.body

  return createPortal(
    <div className="modal-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
        tabIndex={-1}
      >
        <div className="row-between modal-header">
          <h2 id="modal-title" className="modal-title">
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    host,
  )
}
