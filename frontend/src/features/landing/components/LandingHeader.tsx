import { transitionClassName } from '../transitionClassName'

interface LandingHeaderProps {
  mounted: boolean
  leaving: boolean
  onLoginClick: () => void
}

/**
 * Sin logo gráfico todavía (§6.1 del prompt de diseño): el nombre funciona
 * como identidad textual. "Iniciar Sesión" ya no es un <Link> directo: dispara
 * la transición cinematográfica hacia /login (ver LandingPage) y solo navega
 * al terminar la animación, o de inmediato si el usuario pidió menos
 * movimiento (prefers-reduced-motion, resuelto en el propio handler).
 *
 * `mounted`/`leaving` reutilizan las mismas clases `landing-header--*` que
 * usa el header de Login (LoginPage.tsx): la etiqueta del botón ("Iniciar
 * Sesión" aquí, "Volver" allá) se desvanece/aparece con la misma regla CSS
 * en landing.css, en vez de cambiar de texto de golpe en el instante exacto
 * del cambio de ruta (eso era el parpadeo reportado).
 */
export function LandingHeader({ mounted, leaving, onLoginClick }: LandingHeaderProps) {
  return (
    <header className={transitionClassName('landing-header', { mounted, leaving })}>
      <span className="landing-header__brand">NotiHouse Pal</span>
      {/* Sin aria-label: el texto visible ("Iniciar Sesión") ya es el nombre
          accesible del botón — un aria-label aparte solo duplicaba lo mismo
          con otra mayúscula, con riesgo de desincronizarse si el texto
          cambia. */}
      <button type="button" className="landing-header__login" onClick={onLoginClick} disabled={leaving}>
        <span className="landing-header__login-label">Iniciar Sesión</span>
        {/* Destello del que "nace" el zoom hacia el background (§4.1 del prompt). */}
        <span className="landing-header__login-flash" aria-hidden="true" />
      </button>
    </header>
  )
}
