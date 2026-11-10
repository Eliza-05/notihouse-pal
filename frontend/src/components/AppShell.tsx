import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Bell, FileText, Home, LayoutList, Menu, MessageSquare, Mic, Receipt, ScrollText, Wrench, X } from 'lucide-react'
import { useAuth } from '../lib/auth/useAuth'
import { useAlertSummary } from '../features/alerts/hooks'
import './tokens.css'
import './AppShell.css'

const NAV_ITEMS = [
  { to: '/', label: 'Resumen', icon: Home, end: true },
  { to: '/atencion', label: 'Bandeja', icon: LayoutList },
  { to: '/inmuebles', label: 'Inmuebles', icon: Wrench },
  { to: '/obligaciones', label: 'Obligaciones', icon: Receipt },
  { to: '/arriendos', label: 'Arriendos', icon: Receipt },
  { to: '/contratos', label: 'Contratos', icon: ScrollText },
  { to: '/documentos', label: 'Documentos', icon: FileText },
  { to: '/voz', label: 'Nota de voz', icon: Mic },
  { to: '/asistente', label: 'Asistente', icon: MessageSquare },
  { to: '/casos', label: 'Mis solicitudes', icon: LayoutList },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const { data: summary } = useAlertSummary()
  const [menuOpen, setMenuOpen] = useState(false)
  const unread = summary?.unread ?? null

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost btn-sm app-header__menu-btn"
            aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <span className="app-header__brand">NotiHouse Pal</span>
        </div>
        <div className="row">
          <NavLink to="/alertas" className="app-header__bell" aria-label={unread ? `Notificaciones, ${unread} sin leer` : 'Notificaciones'}>
            <Bell size={20} />
            {unread !== null && unread > 0 && (
              <span className="app-header__bell-count" aria-hidden="true">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </NavLink>
          <span className="text-muted app-header__user">{user?.displayName ?? user?.email}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={logout}>
            Cerrar sesión
          </button>
        </div>
      </header>

      <div className="app-body">
        <nav className={`app-nav ${menuOpen ? 'app-nav--open' : ''}`} aria-label="Navegación principal">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `app-nav__link ${isActive ? 'app-nav__link--active' : ''}`}
              onClick={() => setMenuOpen(false)}
            >
              <Icon size={18} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <main className="app-main">{children}</main>
      </div>
    </div>
  )
}
