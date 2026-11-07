import { Link } from 'react-router-dom'

/**
 * Sin logo gráfico todavía (§6.1 del prompt de diseño): el nombre funciona
 * como identidad textual. "Iniciar Sesión" navega a la ruta real de login
 * ya existente (lib/auth), no a un destino ficticio.
 */
export function LandingHeader() {
  return (
    <header className="landing-header">
      <span className="landing-header__brand">NotiHouse Pal</span>
      <Link to="/login" className="landing-header__login">
        Iniciar Sesión
      </Link>
    </header>
  )
}
