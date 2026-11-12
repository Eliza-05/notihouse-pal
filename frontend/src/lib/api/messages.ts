import { ApiError, RequestTimeoutError, isNetworkError } from './errors'

/**
 * Traduce cualquier error a un mensaje en español, sin tecnicismos y, cuando
 * hay algo que hacer, con la acción siguiente. El detalle técnico (estado HTTP,
 * id de correlación) NO se pierde: sigue en el `ApiError` para diagnóstico.
 *
 * Reglas:
 *  - Si el backend ya devolvió una frase clara en español, se respeta (dice qué pasó de verdad).
 *  - Si el texto parece técnico o en inglés, se sustituye por una explicación por tipo de error.
 *  - Nunca se presenta como éxito ni se oculta un fallo real tras un mensaje vacío.
 */

export type ErrorContext = 'load' | 'save' | 'upload' | 'decide' | 'apply' | 'login' | 'generic'

const TECHNICAL = /[{}[\]]|status code|failed to|unexpected|undefined|\bnull\b|exception|should |must |is not |cannot |not found|bad request|internal server|econn|etimedout|typeerror|syntaxerror|\buuid\b|violates|constraint|\bjson\b|gemini|\bn8n\b|\bapi\b|workflow/i

/** ¿El texto del backend es una frase en español apta para mostrar? */
export function isFriendlyMessage(text: string): boolean {
  const t = text.trim()
  if (t.length === 0 || t.length > 240) return false
  if (TECHNICAL.test(t)) return false
  // Un mensaje en español casi siempre trae tildes, ñ o palabras funcionales.
  return /[áéíóúñ¿¡]|\b(el|la|los|las|no|ya|un|una|de|del|para|por|con|se|tu|tus|esta|este|debes|puedes|solo|solamente)\b/i.test(t)
}

const ACTION_HINT: Record<ErrorContext, string> = {
  load: 'Inténtalo de nuevo en unos segundos.',
  save: 'Tus datos no se guardaron. Revisa la información e inténtalo de nuevo.',
  upload: 'El archivo no se envió. Revisa el archivo e inténtalo de nuevo.',
  decide: 'Tu decisión no se registró. Inténtalo de nuevo.',
  apply: 'No se aplicó ningún cambio. Inténtalo de nuevo.',
  login: 'Revisa tus datos e inténtalo de nuevo.',
  generic: 'Inténtalo de nuevo.',
}

export function friendlyError(error: unknown, context: ErrorContext = 'generic'): string {
  if (error instanceof RequestTimeoutError) {
    if (error.isWrite) {
      return 'No recibimos respuesta a tiempo. Es posible que la acción sí se haya registrado: revisa «Mis solicitudes» o recarga la pantalla antes de volver a intentarlo.'
    }
    return 'La solicitud está tardando más de lo normal. Es posible que el servidor esté iniciando; espera unos segundos y vuelve a intentarlo.'
  }
  if (isNetworkError(error)) {
    // Sin respuesta no sabemos si el servidor llegó a recibir la escritura: se invita a comprobarlo antes de repetir.
    const mayHaveSaved = context === 'upload' || context === 'save' || context === 'decide' || context === 'apply'
    return `No pudimos conectar con el servicio. Comprueba tu conexión e inténtalo nuevamente.${
      mayHaveSaved ? ' Si acabas de enviar algo, revisa «Mis solicitudes» o recarga la pantalla antes de repetirlo.' : ''
    }`
  }
  if (!(error instanceof ApiError)) return `Ocurrió un error inesperado. ${ACTION_HINT[context]}`

  const own = error.messages.filter(isFriendlyMessage).join(' ')

  switch (error.status) {
    case 400:
    case 422:
      return own || `Hay datos que no son válidos. ${ACTION_HINT[context]}`
    case 401:
      return context === 'login'
        ? 'El correo o la contraseña no son correctos.'
        : 'Tu sesión venció. Vuelve a iniciar sesión para continuar.'
    case 403:
      return own || 'No tienes permiso para realizar esta acción.'
    case 404:
      return own || 'No encontramos lo que buscas. Puede que ya no exista o que no sea tuyo.'
    case 409:
      if (/ya existe|duplic|ya (fue|est[aá])|ya se/i.test(error.messages.join(' ')) && own) return own
      return own || 'Esto ya se registró o entra en conflicto con información existente. Actualiza la pantalla y revisa antes de volver a intentarlo.'
    case 413:
      return 'El archivo es demasiado grande. Prueba con uno más liviano.'
    case 415:
      if (/contenido activo|incrustad|javascript/i.test(error.messages.join(' '))) {
        return 'Este PDF incluye elementos interactivos o archivos incrustados y no se puede aceptar. Genera una versión sencilla del PDF (por ejemplo, con «Imprimir → Guardar como PDF») y súbela de nuevo.'
      }
      return 'No pudimos aceptar este archivo. Solo se admiten facturas en PDF.'
    case 429:
      return own || 'Hiciste muchas solicitudes seguidas o se alcanzó el límite del servicio. Espera un momento antes de intentarlo otra vez.'
    case 503:
      return 'El servicio está iniciando o no está disponible por ahora. Espera unos segundos e inténtalo de nuevo.'
    default:
      if (error.status >= 500) return 'El servidor tuvo un problema. Inténtalo de nuevo en unos minutos.'
      return own || `No se pudo completar la acción. ${ACTION_HINT[context]}`
  }
}
