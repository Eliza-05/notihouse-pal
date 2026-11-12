import type { Case, HitlRequest, Proposal } from '../../lib/api/types'
import { isFriendlyMessage } from '../../lib/api/messages'
import { parseProposal } from './proposalSchema'
import { reviewMode } from './reviewMode'

/**
 * Progreso de una solicitud, construido SOLO con lo que el backend informa:
 * estado del caso, revisiones y propuestas (con `appliedAt`). No se inventan etapas ni porcentajes:
 * el análisis con IA se muestra como «en curso» sin tiempo restante porque no se conoce.
 *
 * Importante: `case.status = completed` significa que el proceso se cerró, NO que la propuesta se aplicó.
 */

export type StepState = 'done' | 'active' | 'waiting' | 'skipped' | 'failed'

export interface ProgressStep {
  key: 'received' | 'analysis' | 'review' | 'apply'
  title: string
  text: string
  state: StepState
}

export interface CaseProgress {
  steps: ProgressStep[]
  /** Frase principal del estado actual. */
  headline: string
  /** Hay trabajo en curso (mostrar indicador de actividad). */
  busy: boolean
  /** Lleva más tiempo del habitual en cola/proceso. */
  slow: boolean
  tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger'
  /** Aviso extra cuando tarda (sin prometer un tiempo restante). */
  slowNote?: string
}

const SLOW_AFTER_MS = 90_000

const WHAT: Record<string, string> = {
  document: 'factura',
  gmail: 'factura del correo',
  voice: 'nota de voz',
  form: 'solicitud',
}
const RECEIVED_TEXT: Record<string, string> = {
  document: 'Recibimos tu documento.',
  gmail: 'Recibimos tu correo con la factura.',
  voice: 'Recibimos tu nota de voz.',
  form: 'Recibimos tu solicitud.',
}

/** Quita el prefijo técnico del flujo («PERMANENTE:» / «TEMPORAL:») y explica en claro. */
export function friendlyReason(reason: string | null | undefined, source?: string): string {
  if (!reason) return 'No pudimos completar el análisis.'
  const subject = source === 'voice' ? 'la nota de voz' : source === 'form' ? 'el mensaje' : 'el documento'
  const clean = reason.replace(/^(PERMANENTE|TEMPORAL)\s*:\s*/i, '').trim()
  if (/texto seleccionable|ocr/i.test(clean)) {
    return 'El PDF parece una imagen escaneada y por ahora solo podemos leer PDF con texto. Sube una versión con texto seleccionable.'
  }
  if (/inteligible|voz/i.test(clean)) return 'No se entendió la voz en el audio. Graba de nuevo hablando con calma y cerca del micrófono.'
  if (/supera|tama[ñn]o|formato|no se pudo leer/i.test(clean)) {
    return source === 'voice'
      ? 'No pudimos procesar el audio: es demasiado largo o su formato no se admite. Graba una nota más corta e inténtalo de nuevo.'
      : 'No pudimos procesar el contenido: es demasiado grande o su formato no se admite. Prueba con uno más sencillo.'
  }
  if (/cuota|429|l[ií]mite/i.test(clean)) return 'El servicio de análisis alcanzó su límite por ahora. Inténtalo de nuevo más tarde.'
  if (/respuesta incompleta|bloque|no acept|json|formato esperado|resultado desconocido/i.test(clean)) {
    return `El asistente no pudo interpretar ${subject} esta vez. Inténtalo de nuevo en unos minutos${source === 'document' || source === 'gmail' ? ' o sube otro archivo' : ''}.`
  }
  // Texto del backend cuando se agotan los reintentos: «La automatización "text.interpret" falló de forma definitiva».
  if (/automatizaci[oó]n|falló de forma definitiva|\b(text|voice|document|case|gmail)\.[a-z_]+\b/i.test(clean) || !isFriendlyMessage(clean)) {
    return 'No pudimos completar el análisis. El asistente no está disponible en este momento. Revisa el estado de tu solicitud antes de volver a intentarlo.'
  }
  return clean
}

export interface CaseProgressInput {
  caseRow: Pick<Case, 'status' | 'source' | 'createdAt' | 'statusReason'>
  hitl: readonly HitlRequest[] | undefined
  proposals: readonly Proposal[] | undefined
  now?: number
}

export function caseProgress({ caseRow, hitl, proposals, now = Date.now() }: CaseProgressInput): CaseProgress {
  const what = WHAT[caseRow.source] ?? 'solicitud'
  const latestHitl = [...(hitl ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const latestProposal = [...(proposals ?? [])].sort((a, b) => b.version - a.version)[0]
  const parsed = latestProposal ? parseProposal(latestProposal.proposedData) : null
  const mode = latestHitl ? reviewMode({ decisionType: latestHitl.decisionType, options: latestHitl.options ?? {}, proposal: latestProposal ?? null }, parsed) : null

  const s = caseRow.status
  const inFlight = s === 'received' || s === 'processing'
  const ageMs = now - new Date(caseRow.createdAt).getTime()
  const slow = inFlight && ageMs > SLOW_AFTER_MS

  const received: ProgressStep = { key: 'received', title: 'Recibido', text: RECEIVED_TEXT[caseRow.source] ?? 'Recibimos tu solicitud.', state: 'done' }

  let analysis: ProgressStep
  switch (s) {
    case 'received':
      analysis = { key: 'analysis', title: 'Análisis', text: 'En cola: se procesará en unos instantes.', state: 'waiting' }
      break
    case 'processing':
      analysis = { key: 'analysis', title: 'Análisis', text: 'Estamos analizando la información.', state: 'active' }
      break
    case 'failed':
      analysis = { key: 'analysis', title: 'Análisis', text: friendlyReason(caseRow.statusReason, caseRow.source), state: 'failed' }
      break
    case 'cancelled':
      analysis = { key: 'analysis', title: 'Análisis', text: 'La solicitud fue cancelada.', state: 'skipped' }
      break
    default:
      analysis = { key: 'analysis', title: 'Análisis', text: 'Análisis terminado.', state: 'done' }
  }

  let review: ProgressStep = { key: 'review', title: 'Tu revisión', text: 'Cuando termine el análisis te pediremos confirmar.', state: 'waiting' }
  let apply: ProgressStep = { key: 'apply', title: 'Aplicación', text: 'Se podrá aplicar después de tu aprobación.', state: 'waiting' }
  let headline = ''
  let tone: CaseProgress['tone'] = 'neutral'

  if (s === 'failed') {
    review = { ...review, text: 'No hay nada que revisar.', state: 'skipped' }
    apply = { ...apply, text: 'No se aplicó nada.', state: 'skipped' }
    headline = 'No pudimos completar el análisis'
    tone = 'danger'
  } else if (s === 'cancelled') {
    review = { ...review, text: 'No hay nada que revisar.', state: 'skipped' }
    apply = { ...apply, text: 'No se aplicó nada.', state: 'skipped' }
    headline = 'Solicitud cancelada'
  } else if (s === 'received') {
    headline = `Recibimos tu ${what}`
    tone = 'info'
  } else if (s === 'processing') {
    headline = `Estamos procesando tu ${what}`
    tone = 'info'
  } else if (s === 'awaiting_human') {
    review = { ...review, text: 'La propuesta está lista para revisar.', state: 'active' }
    headline = 'La propuesta está lista para revisar'
    tone = 'warning'
  } else if (latestHitl) {
    // completed: el cierre ocurrió; lo que pasó con la propuesta lo dicen la revisión y appliedAt.
    switch (latestHitl.status) {
      case 'rejected':
        review = { ...review, text: 'Rechazaste la propuesta.', state: 'done' }
        apply = { ...apply, text: 'No se registró nada.', state: 'skipped' }
        headline = 'Rechazaste la propuesta: no se registró nada'
        break
      case 'expired':
        review = { ...review, text: 'La revisión venció sin decisión.', state: 'failed' }
        apply = { ...apply, text: 'No se aplicó nada.', state: 'skipped' }
        headline = 'La revisión venció sin decisión'
        tone = 'danger'
        break
      case 'approved':
        if (mode === 'applicable') {
          review = { ...review, text: 'Aprobaste la propuesta.', state: 'done' }
          const applied = latestProposal?.appliedAt
          if (typeof applied === 'string' && applied) {
            apply = { ...apply, text: 'La propuesta se aplicó a tus datos.', state: 'done' }
            headline = 'Propuesta aplicada'
            tone = 'success'
          } else if (applied === null) {
            apply = { ...apply, text: 'Falta aplicar la propuesta para registrar el cambio.', state: 'active' }
            headline = 'Aprobada: falta aplicarla'
            tone = 'warning'
          } else {
            apply = { ...apply, text: 'Si todavía no la aplicaste, hazlo desde la revisión.', state: 'waiting' }
            headline = 'Revisión cerrada'
          }
        } else {
          review = { ...review, text: mode === 'choice' ? 'Registraste tu elección.' : 'Revisaste la información.', state: 'done' }
          apply = { ...apply, text: 'No había nada que aplicar.', state: 'skipped' }
          headline = mode === 'choice' ? 'Elección registrada' : 'Revisada: no había nada que aplicar'
          tone = 'success'
        }
        break
      default:
        headline = 'Proceso cerrado'
    }
  } else {
    review = { ...review, text: 'No se requirió tu revisión.', state: 'skipped' }
    apply = { ...apply, text: 'No había nada que aplicar.', state: 'skipped' }
    headline = 'Proceso cerrado'
    tone = 'success'
  }

  return {
    steps: [received, analysis, review, apply],
    headline,
    busy: inFlight,
    slow,
    tone,
    slowNote: slow ? `Tu ${what} sigue procesándose. Puedes seguir usando NotiHouse-Pal y revisar el resultado desde Mis solicitudes.` : undefined,
  }
}
