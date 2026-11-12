import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bell, Clock, FolderClock, LogOut, Moon, Sun } from 'lucide-react'
import { useAuth } from '../lib/auth/useAuth'
import { queryKey } from '../lib/api/queryKey'
import { getMe } from '../features/auth/api'

function initials(name: string) {
  const parts = name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'NH'
}

function minutesLeft(expiresAt: number | null, now: number) {
  if (!expiresAt) return null
  return Math.max(0, Math.ceil((expiresAt - now) / 60000))
}

/**
 * Menú del avatar. El backend solo expone GET /auth/me (id, correo, nombre):
 * no hay edición de perfil, cambio de contraseña ni logout en servidor, así
 * que el menú muestra el perfil, el tiempo restante del JWT (2 h, sin
 * refresh) y accesos rápidos.
 */
export function UserMenu({ isDark, onToggleTheme }: { isDark: boolean; onToggleTheme: () => void }) {
  const { user, expiresAt, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)

  const me = useQuery({
    queryKey: queryKey(user?.id ?? 'anon', 'auth', 'me'),
    queryFn: getMe,
    enabled: open && !!user,
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    if (!open) return
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    function onPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      clearInterval(tick)
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const profile = me.data ?? user
  const name = profile?.displayName ?? profile?.email ?? ''
  const left = minutesLeft(expiresAt, now)

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        type="button"
        className="avatar avatar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Menú de usuario: ${name}`}
        title={name}
        onClick={() => {
          setNow(Date.now())
          setOpen((v) => !v)
        }}
      >
        {initials(name)}
      </button>

      {open && (
        <div className="user-pop" role="menu">
          <div className="user-pop-head">
            <span className="avatar user-pop-avatar" aria-hidden="true">
              {initials(name)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="user-pop-name">{profile?.displayName ?? 'Sin nombre visible'}</div>
              <div className="user-pop-email">{profile?.email}</div>
            </div>
          </div>

          <div className="user-pop-session">
            <Clock size={14} aria-hidden="true" />
            {left === null ? 'Sesión activa' : left <= 1 ? 'Tu sesión vence en menos de un minuto' : `Tu sesión vence en ${left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min` : `${left} min`}`}
          </div>
          {me.isError && <div className="user-pop-note">No pudimos confirmar tu perfil con el servidor.</div>}

          <div className="user-pop-list">
            <Link to="/alertas" role="menuitem" className="user-pop-item" onClick={() => setOpen(false)}>
              <Bell size={16} aria-hidden="true" />
              Alertas
            </Link>
            <Link to="/casos" role="menuitem" className="user-pop-item" onClick={() => setOpen(false)}>
              <FolderClock size={16} aria-hidden="true" />
              Mis solicitudes
            </Link>
            <button type="button" role="menuitem" className="user-pop-item" onClick={onToggleTheme}>
              {isDark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
              {isDark ? 'Tema claro' : 'Tema oscuro'}
            </button>
          </div>

          <button type="button" role="menuitem" className="user-pop-item user-pop-logout" onClick={logout}>
            <LogOut size={16} aria-hidden="true" />
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  )
}
