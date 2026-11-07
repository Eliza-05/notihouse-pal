import landingBackground from '../../../assets/backgrounds/LandingBackground.png'
import { MoreInfoButton } from './MoreInfoButton'

interface LandingHeroProps {
  onMoreInfo: () => void
}

/**
 * Composición asimétrica: texto sobre el espacio negativo izquierdo del
 * fondo, objetos (llaves, calculadora, libreta) concentrados a la derecha.
 * `background-position` se reajusta por breakpoint en landing.css para que
 * el recorte de `cover` nunca tape esos objetos ni quede texto encima de
 * ellos (requisito del prompt de diseño, §4).
 */
export function LandingHero({ onMoreInfo }: LandingHeroProps) {
  return (
    <section className="landing-hero" aria-label="Presentación de NotiHouse Pal">
      {/* <img> + object-fit en vez de background-image: permite reencuadrar
          por breakpoint (object-position) y hacer zoom con transform sin
          deformar la imagen — más predecible que recalcular background-size
          a mano para cada ancho (§4 del prompt de diseño: nunca deformar). */}
      <img src={landingBackground} alt="" className="landing-hero__image" aria-hidden="true" />
      <div className="landing-hero__scrim" aria-hidden="true" />

      <div className="landing-hero__content">
        {/* El nombre ya vive en el Header (LandingHeader); repetirlo aquí era
            redundante. La frase se conserva partida en dos líneas para no
            perder la composición de título de dos renglones. */}
        <h1 className="landing-hero__title">
          <span className="landing-hero__title-line landing-hero__title-line--fade">Automatiza, organiza</span>
          <span className="landing-hero__title-line landing-hero__title-line--fade">y mantén el control.</span>
        </h1>

        <p className="landing-hero__description">
          Centraliza tus inmuebles, arriendos, contratos y vencimientos en un solo lugar. Anticípate a tus
          obligaciones con asistencia inteligente y conserva siempre el control de tus decisiones.
        </p>

        <MoreInfoButton onClick={onMoreInfo} />
      </div>
    </section>
  )
}
