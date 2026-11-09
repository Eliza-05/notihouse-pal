import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LandingHeader } from './components/LandingHeader'
import { LandingHero } from './components/LandingHero'
import './landing.css'

// Duración de la animación de salida (debe coincidir con el `transition`
// más largo de .landing-hero--leaving en landing.css) antes de navegar a
// /login. Vive aquí, no en CSS, porque JS es quien decide cuándo cambiar
// de ruta.
const LEAVE_ANIMATION_MS = 820

export function LandingPage() {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)
  // Mismo patrón que LoginPage (ver mounted ahí): el contenido del Hero y la
  // etiqueta del botón del Header entran con transition, no con @keyframes,
  // para que esta misma clase pueda revertirse al salir (handleLoginClick)
  // sin que compitan dos animaciones por la misma propiedad. Se activa un
  // frame después del montaje — incluso al volver desde /login — para que
  // SIEMPRE haya una transición real de opacity 0→1 en vez de aparecer ya
  // visible de entrada.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  // Punto de extensión único: cuando se construya la secuencia de 3 pop-ups
  // (Gestiona / Monitorea / Recibe, inspirados en iOS), solo este handler
  // cambia — Header, Hero y el botón quedan intactos.
  function handleMoreInfo() {
    // TODO(popups): abrir la secuencia de 3 pasos. Intencionalmente vacío
    // por ahora — el prompt de diseño pide no implementar modales ni
    // contenido provisional en esta fase.
  }

  function handleLoginClick() {
    if (leaving) return // evita doble disparo si el usuario repite el clic

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion) {
      // Sin zoom cinematográfico: navegación directa (la hoja de estilos ya
      // reduce cualquier transición residual a ~0 para estos casos).
      navigate('/login')
      return
    }

    setLeaving(true)
    window.setTimeout(() => navigate('/login'), LEAVE_ANIMATION_MS)
  }

  return (
    <div className="landing-page">
      <LandingHeader mounted={mounted} leaving={leaving} onLoginClick={handleLoginClick} />
      <main>
        <LandingHero mounted={mounted} leaving={leaving} onMoreInfo={handleMoreInfo} />
      </main>
    </div>
  )
}
