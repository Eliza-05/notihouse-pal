import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bell, CalendarClock, FileCheck2, UserCheck, X, type LucideIcon } from 'lucide-react'
import { SkeletonRows } from '../../components/Feedback'
import { useMarkAlertRead } from '../alerts/hooks'
import type { AppNotification } from './derive'
import { useNotificationsState } from './NotificationsProvider'
import './NotificationBell.css'

const ICON_BY_EVENT: Record<AppNotification['event'], LucideIcon> = {
  apply_pending: FileCheck2,
  review_pending: UserCheck,
  due: CalendarClock,
}

function Item({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const Icon = ICON_BY_EVENT[n.event]
  return (
    <li>
      <button type="button" className={`notif-item notif-${n.priority}`} onClick={() => onOpen(n)}>
        <span className="notif-icon" aria-hidden="true">
          <Icon size={17} />
        </span>
        <span className="notif-text">
          <span className="notif-title">{n.title}</span>
          <span className="notif-body">{n.body}</span>
          <span className="notif-action">{n.actionLabel} →</span>
        </span>
      </button>
    </li>
  )
}

/**
 * Campana con panel de avisos. Muestra lo que requiere acción (revisiones por decidir o por aplicar) y
 * los vencimientos cercanos; cada aviso lleva directo a su pantalla. El indicador cuenta solo lo que pide
 * atención. No es una notificación del sistema operativo: solo existe mientras la aplicación está abierta.
 */
export function NotificationBell() {
  const { notifications, badge, isLoading, isError, refetch } = useNotificationsState()
  const markRead = useMarkAlertRead()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  function openItem(n: AppNotification) {
    if (n.alertId) markRead.mutate(n.alertId)
    setOpen(false)
    navigate(n.to)
  }

  const high = notifications.filter((n) => n.priority === 'high')
  const medium = notifications.filter((n) => n.priority === 'medium')
  const label = badge > 0 ? `Notificaciones, ${badge} por atender` : 'Notificaciones, sin pendientes'

  return (
    <div className="notif-root" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn bell"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Notificaciones"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell aria-hidden="true" />
        {badge > 0 && (
          <span className="bell-count" aria-hidden="true">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-panel" id={panelId} role="dialog" aria-label="Notificaciones">
          <div className="notif-head">
            <span className="notif-head-title">Notificaciones</span>
            <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar notificaciones">
              <X aria-hidden="true" />
            </button>
          </div>

          <div className="notif-scroll">
            {isLoading && <SkeletonRows rows={3} label="Cargando notificaciones…" />}

            {isError && (
              <div className="notif-empty" role="alert">
                <p>No pudimos actualizar tus avisos.</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={refetch}>
                  Reintentar
                </button>
              </div>
            )}

            {!isLoading && !isError && notifications.length === 0 && (
              <div className="notif-empty">
                <p>No tienes pendientes por ahora.</p>
              </div>
            )}

            {high.length > 0 && (
              <section aria-label="Requieren tu atención">
                <h3 className="notif-section">Requieren tu atención</h3>
                <ul className="notif-list">
                  {high.map((n) => (
                    <Item key={n.key} n={n} onOpen={openItem} />
                  ))}
                </ul>
              </section>
            )}
            {medium.length > 0 && (
              <section aria-label="Próximos vencimientos">
                <h3 className="notif-section">Próximos vencimientos</h3>
                <ul className="notif-list">
                  {medium.map((n) => (
                    <Item key={n.key} n={n} onOpen={openItem} />
                  ))}
                </ul>
              </section>
            )}
          </div>

          <div className="notif-foot">
            <Link to="/atencion" onClick={() => setOpen(false)}>
              Abrir Bandeja
            </Link>
            <Link to="/alertas" onClick={() => setOpen(false)}>
              Ver alertas
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
