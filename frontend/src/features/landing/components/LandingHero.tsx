import landingBackground from '../../../assets/backgrounds/LandingBackground.png'
import { transitionClassName } from '../transitionClassName'
import { MoreInfoButton } from './MoreInfoButton'

interface LandingHeroProps {
  mounted: boolean
  leaving: boolean
  onMoreInfo: () => void
}

/**
 * Composición asimétrica: texto sobre el espacio negativo izquierdo del
 * fondo, objetos (llaves, calculadora, libreta) concentrados a la derecha.
 * `background-position` se reajusta por breakpoint en landing.css para que
 * el recorte de `cover` nunca tape esos objetos ni quede texto encima de
 * ellos (requisito del prompt de diseño, §4).
 *
 * `leaving` activa el acercamiento de cámara hacia /login (ver landing.css,
 * sección "Transición cinematográfica"): la imagen hace zoom hacia la zona
 * roja junto a las llaves, el scrim y el contenido se desvanecen. `mounted`
 * hace que `.landing-hero__content` (título/descripción/botón) entre con el
 * mismo fundido+translateY que ya usa el formulario de Login, en vez de
 * aparecer ya visible desde el primer frame — notorio sobre todo al volver
 * desde /login con "Volver".
 */
export function LandingHero({ mounted, leaving, onMoreInfo }: LandingHeroProps) {
  return (
    <section
      className={transitionClassName('landing-hero', { mounted, leaving })}
      aria-label="Presentación de NotiHouse Pal"
    >
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
