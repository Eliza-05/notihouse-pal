interface TransitionState {
  mounted: boolean
  leaving: boolean
}

/**
 * Compone las clases `<base>`, `<base>--mounted` y `<base>--leaving` del
 * mecanismo de transición compartido entre Landing y Login (ver landing.css
 * y login.css, sección "Transición cinematográfica"): un estado React
 * (`mounted`/`leaving`) maneja SIEMPRE ambas direcciones con `transition`,
 * nunca con `@keyframes ... forwards` (ver nota en login.css sobre por qué
 * eso rompía el fundido de salida).
 *
 * Antes esta misma cadena de ternarios se repetía, idéntica, en LandingHeader,
 * LandingHero y LoginPage (header + raíz de la página) — con el riesgo de que
 * una de las cuatro copias se editara sin las otras. Centralizarla aquí evita
 * esa divergencia.
 */
export function transitionClassName(base: string, { mounted, leaving }: TransitionState): string {
  return [base, mounted && `${base}--mounted`, leaving && `${base}--leaving`].filter(Boolean).join(' ')
}
