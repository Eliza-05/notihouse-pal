import { ArrowRight } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'

interface MoreInfoButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {}

/**
 * Componente independiente a propósito: su presentación (este archivo) está
 * separada de su comportamiento (el `onClick` que recibe por props). Hoy no
 * abre nada — es el punto de entrada reservado para la secuencia de 3
 * pop-ups (Gestiona / Monitorea / Recibe) que se construirá en otra rama,
 * sin tener que tocar el Hero cuando eso pase.
 */
export function MoreInfoButton(props: MoreInfoButtonProps) {
  return (
    <button type="button" className="landing-more-info" {...props}>
      Más información
      <ArrowRight size={18} strokeWidth={2.25} aria-hidden="true" />
    </button>
  )
}
