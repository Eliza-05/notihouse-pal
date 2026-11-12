import { useExpiryWarning } from '../lib/auth/useAuth'
import './SessionExpiryBanner.css'

/**
 * Aviso discreto de vencimiento de sesión (JWT de 2 h, sin renovación). No guarda
 * borradores ni nada sensible: solo recuerda terminar lo que se esté haciendo, porque al
 * vencer habrá que iniciar sesión de nuevo.
 */
export function SessionExpiryBanner() {
  const minutes = useExpiryWarning()
  if (minutes === null) return null
  return (
    <p className="session-expiry-banner" role="status">
      Tu sesión vence en {minutes} {minutes === 1 ? 'minuto' : 'minutos'}. Termina lo que estás haciendo: después tendrás
      que iniciar sesión de nuevo y volverás a esta misma pantalla.
    </p>
  )
}
