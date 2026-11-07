import { LandingHeader } from './components/LandingHeader'
import { LandingHero } from './components/LandingHero'
import './landing.css'

export function LandingPage() {
  // Punto de extensión único: cuando se construya la secuencia de 3 pop-ups
  // (Gestiona / Monitorea / Recibe, inspirados en iOS), solo este handler
  // cambia — Header, Hero y el botón quedan intactos.
  function handleMoreInfo() {
    // TODO(popups): abrir la secuencia de 3 pasos. Intencionalmente vacío
    // por ahora — el prompt de diseño pide no implementar modales ni
    // contenido provisional en esta fase.
  }

  return (
    <div className="landing-page">
      <LandingHeader />
      <main>
        <LandingHero onMoreInfo={handleMoreInfo} />
      </main>
    </div>
  )
}
