import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Bell,
  ChevronLeft,
  Ellipsis,
  FileText,
  FileUp,
  FolderClock,
  House,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mic,
  Moon,
  Receipt,
  Sparkles,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../lib/auth/useAuth'
import { useAlertSummary } from '../features/alerts/hooks'
import { NotificationBell } from '../features/notifications/NotificationBell'
import { NotificationToaster } from '../features/notifications/NotificationToaster'
import { NotificationsProvider } from '../features/notifications/NotificationsProvider'
import { ToastViewport } from './Toasts'
import { UserMenu } from './UserMenu'
import './tokens.css'
import './AppShell.css'

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean }

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Resumen', icon: LayoutDashboard, end: true },
  { to: '/atencion', label: 'Bandeja', icon: Inbox },
  { to: '/inmuebles', label: 'Inmuebles', icon: House },
  { to: '/obligaciones', label: 'Obligaciones', icon: Receipt },
  { to: '/arriendos', label: 'Arriendos', icon: KeyRound },
  { to: '/contratos', label: 'Contratos', icon: FileText },
  { to: '/documentos', label: 'Documentos', icon: FileUp },
  { to: '/voz', label: 'Nota de voz', icon: Mic },
  { to: '/asistente', label: 'Asistente', icon: Sparkles },
  { to: '/casos', label: 'Mis solicitudes', icon: FolderClock },
]

/** Accesos fijos del dock móvil; el resto vive en la hoja "Más". */
const DOCK_PATHS = ['/', '/atencion', '/obligaciones', '/asistente']
const DOCK_ITEMS = NAV_ITEMS.filter((item) => DOCK_PATHS.includes(item.to))

const THEME_KEY = 'nh-theme'
const COLLAPSE_KEY = 'nh-sidebar-collapsed'

function isItemActive(item: NavItem, pathname: string) {
  if (item.end) return pathname === item.to
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* almacenamiento no disponible: la preferencia solo dura la visita */
  }
}

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(() => {
    const saved = readStorage(THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : null
  })

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
  }, [theme])

  function toggle() {
    const current = theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    const next = current === 'dark' ? 'light' : 'dark'
    writeStorage(THEME_KEY, next)
    setTheme(next)
  }

  const isDark = theme ? theme === 'dark' : typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  return { isDark, toggle }
}

function todayLabel() {
  const text = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const { data: summary } = useAlertSummary()
  const { pathname } = useLocation()
  const { isDark, toggle } = useTheme()
  const [collapsed, setCollapsed] = useState(() => readStorage(COLLAPSE_KEY) === '1')
  const [moreOpen, setMoreOpen] = useState(false)
  const unread = summary?.unread ?? null

  const firstName = user?.displayName?.split(' ')[0]

  const activeIndex = NAV_ITEMS.findIndex((item) => isItemActive(item, pathname))
  const dockIndex = DOCK_ITEMS.findIndex((item) => isItemActive(item, pathname))
  const dockActive = dockIndex >= 0 ? dockIndex : DOCK_ITEMS.length // "Más"

  useEffect(() => {
    if (!moreOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [moreOpen])

  function toggleCollapsed() {
    setCollapsed((value) => {
      writeStorage(COLLAPSE_KEY, value ? '0' : '1')
      return !value
    })
  }

  return (
    <NotificationsProvider>
    <div className="app-shell">
      <a href="#contenido" className="skip-link">Saltar al contenido</a>
      <NotificationToaster />
      <ToastViewport />
      <div className="ambient" aria-hidden="true">
        <div className="blob a" />
        <div className="blob b" />
        <div className="blob c" />
      </div>

      <div className={`app ${collapsed ? 'is-collapsed' : ''}`}>
        {/* ---------------- Sidebar: isla flotante (escritorio) ---------------- */}
        <aside className="sidebar">
          <div className="brand-badge">
            <svg className="brand-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M5.5 9.5V19a1 1 0 0 0 1 1H10v-5.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V20h3.5a1 1 0 0 0 1-1V9.5" />
            </svg>
            <span className="brand-copy">
              <span className="brand-name">NotiHouse Pal</span>
              <span className="brand-sub">Panel del propietario</span>
            </span>
          </div>

          <nav className="side-tabs" aria-label="Navegación principal" style={{ '--active-index': activeIndex } as React.CSSProperties}>
            {activeIndex >= 0 && <span className="side-indicator" aria-hidden="true" />}
            {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} title={label} className={({ isActive }) => `tab-btn ${isActive ? 'is-active' : ''}`}>
                <Icon className="icon" aria-hidden="true" />
                <span className="label">{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="sidebar-foot">
            <div className="lbl">Alertas sin leer</div>
            <div className="foot-row">
              <span className="val">{unread ?? '—'}</span>
              <button
                type="button"
                className="collapse-btn"
                onClick={toggleCollapsed}
                aria-label={collapsed ? 'Expandir panel' : 'Contraer panel'}
                aria-expanded={!collapsed}
                title={collapsed ? 'Expandir panel' : 'Contraer panel'}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
            </div>
            <NavLink to="/alertas" className="sub">
              Ver alertas
            </NavLink>
          </div>
        </aside>

        {/* ---------------- Contenido ---------------- */}
        <main className="app-main" id="contenido" tabIndex={-1}>
          <header className="topbar">
            <div className="topbar-copy">
              <div className="topbar-title">{firstName ? `Hola, ${firstName}` : 'Hola'}</div>
              <div className="topbar-date">{todayLabel()}</div>
            </div>
            <div className="topbar-right">
              <NotificationBell />
              <button
                type="button"
                className="icon-btn theme-toggle"
                onClick={toggle}
                aria-label={isDark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
                title="Cambiar tema"
              >
                {isDark ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
              </button>
              <UserMenu isDark={isDark} onToggleTheme={toggle} />
            </div>
          </header>

          <div className="page">{children}</div>
        </main>
      </div>

      {/* ---------------- Dock inferior (móvil) ---------------- */}
      <nav className="dock" aria-label="Navegación principal" style={{ '--active-index': dockActive } as React.CSSProperties}>
        <span className="dock-indicator" aria-hidden="true" />
        {DOCK_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `dock-btn ${isActive ? 'is-active' : ''}`}
            onClick={() => setMoreOpen(false)}
          >
            <Icon className="icon" aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className={`dock-btn ${dockIndex < 0 ? 'is-active' : ''}`}
          aria-expanded={moreOpen}
          aria-controls="more-sheet"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <Ellipsis className="icon" aria-hidden="true" />
          <span>Más</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="sheet-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setMoreOpen(false)}>
          <div className="sheet" id="more-sheet" role="dialog" aria-modal="true" aria-label="Más secciones">
            <div className="sheet-head">
              <span className="sheet-title">Más secciones</span>
              <button type="button" className="icon-btn" onClick={() => setMoreOpen(false)} aria-label="Cerrar">
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="sheet-grid">
              {[...NAV_ITEMS.filter((item) => !DOCK_PATHS.includes(item.to)), { to: '/alertas', label: 'Alertas', icon: Bell }].map(
                ({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) => `sheet-link ${isActive ? 'is-active' : ''}`}
                    onClick={() => setMoreOpen(false)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </NavLink>
                ),
              )}
            </div>
            <button type="button" className="btn btn-secondary sheet-logout" onClick={logout}>
              <LogOut size={16} aria-hidden="true" />
              Cerrar sesión
            </button>
          </div>
        </div>
      )}
    </div>
    </NotificationsProvider>
  )
}
