import type { AttentionItem, HitlDetail, HitlRequest } from '../../lib/api/types'
import { formatMoney } from '../../lib/format/money'
import { resourcePathToRoute } from '../../lib/navigation'
import { parseProposal } from '../cases/proposalSchema'
import { reviewMode } from '../cases/reviewMode'
import { reviewStage } from '../cases/reviewState'
import { humanizeText, reviewHeading } from '../cases/reviewSummary'

/**
 * Notificaciones RELEVANTES dentro de la app. No hay un sistema paralelo de alertas: se
 * derivan de lo que el backend ya expone (revisiones HITL, Bandeja de atención y estado de
 * aplicación de propuestas). Solo se avisa de lo que requiere una acción o un vencimiento;
 * editar, navegar o guardar no generan notificaciones (eso es feedback de acción, ver Toasts).
 */

export type NotificationPriority = 'high' | 'medium'
export type NotificationEvent = 'review_pending' | 'apply_pending' | 'due'

export interface AppNotification {
  /** Estable por usuario + recurso + evento: el mismo hecho nunca genera dos avisos. */
  key: string
  priority: NotificationPriority
  event: NotificationEvent
  title: string
  body: string
  /** Pantalla a la que lleva. */
  to: string
  actionLabel: string
  /** Cuenta para el indicador de la campana. */
  counts: boolean
  /** Referencia para marcar la alerta como leída al abrirla (solo avisos de vencimiento con alerta). */
  alertId?: string
  /** Texto para ordenar: instante de creación o fecha relevante. */
  sortAt: string
}

export interface PendingReview {
  request: HitlRequest
  /** Detalle con la propuesta; puede no haber llegado todavía. */
  detail?: HitlDetail
}

export const notificationKey = (userId: string, resource: string, id: string, event: string) => `${userId}:${resource}:${id}:${event}`

function reviewNotification(userId: string, r: PendingReview): AppNotification {
  const key = notificationKey(userId, 'hitl', r.request.id, 'review_pending')
  const to = `/revisiones/${r.request.id}`
  const base = { key, priority: 'high' as const, event: 'review_pending' as const, to, counts: true, sortAt: r.request.createdAt }

  const detail = r.detail
  if (!detail) {
    return { ...base, title: 'Tienes una revisión por hacer', body: humanizeText(r.request.options.summary ?? 'Hay una propuesta esperando tu decisión.'), actionLabel: 'Revisar' }
  }
  const parsed = detail.proposal ? parseProposal(detail.proposal.proposedData) : null
  const mode = reviewMode(detail, parsed)
  const heading = reviewHeading(detail, parsed)
  const fromDocument = detail.proposal?.documentId != null

  if (mode === 'applicable' && parsed?.kind === 'known' && parsed.value.action === 'create_obligation_with_occurrence' && fromDocument) {
    const provider = heading.subject ?? 'un proveedor'
    const money = heading.amount ? ` por ${formatMoney(heading.amount, 'COP')}` : ''
    return { ...base, title: 'Tienes una factura por revisar', body: `Recibimos una factura de ${provider}${money}. Necesitamos tu aprobación para registrarla.`, actionLabel: 'Revisar factura' }
  }
  if (mode === 'applicable') {
    return { ...base, title: 'Tienes una propuesta por revisar', body: heading.description, actionLabel: 'Revisar propuesta' }
  }
  if (mode === 'choice') {
    return { ...base, title: 'Necesitamos que elijas una opción', body: heading.description, actionLabel: 'Elegir' }
  }
  return { ...base, title: 'Una solicitud necesita tu atención', body: heading.description, actionLabel: 'Ver solicitud' }
}

function applyNotification(userId: string, detail: HitlDetail): AppNotification | null {
  const parsed = detail.proposal ? parseProposal(detail.proposal.proposedData) : null
  const info = reviewStage(detail, parsed)
  // Solo cuando el backend afirma que NO se aplicó (appliedAt === null). Si no informa, no se afirma nada.
  if (info.stage !== 'approved_pending_apply') return null
  const heading = reviewHeading(detail, parsed)
  return {
    key: notificationKey(userId, 'hitl', detail.id, 'apply_pending'),
    priority: 'high',
    event: 'apply_pending',
    title: 'Aprobaste una propuesta que falta aplicar',
    body: `${heading.title}. Aprobar solo confirma: para registrar el cambio hay que aplicarla.`,
    to: `/revisiones/${detail.id}`,
    actionLabel: 'Aplicar',
    counts: true,
    sortAt: detail.respondedAt ?? detail.updatedAt,
  }
}

/** Los avisos por vencimiento vienen de la Bandeja (el backend ya calcula condición y ventana). */
function dueNotification(userId: string, item: AttentionItem): AppNotification | null {
  if (item.kind === 'hitl_request') return null
  const overdueOrToday = item.condition === 'overdue' || item.condition === 'due_today'
  const unreadAlert = item.alert !== null && !item.alert.read
  const what = item.kind === 'contract' ? 'Contrato' : item.kind === 'rent_charge' ? 'Cobro de arriendo' : 'Obligación'
  const money = item.amount ? ` · ${formatMoney(item.amount, item.currency ?? 'COP')}` : ''
  return {
    key: notificationKey(userId, item.kind, item.id, `due:${item.condition}`),
    priority: 'medium',
    event: 'due',
    title: `${what}: ${item.title}`,
    body: `${item.description}${money}`,
    to: resourcePathToRoute(item.resource.path),
    actionLabel: 'Abrir',
    // Un vencimiento «próximo» sin alerta es informativo: se lista, pero no infla el contador.
    counts: overdueOrToday || unreadAlert,
    alertId: item.alert && !item.alert.read ? item.alert.id : undefined,
    sortAt: item.relevantDate,
  }
}

export interface DeriveInput {
  userId: string
  pending: PendingReview[]
  approved: HitlDetail[]
  attention: AttentionItem[]
}

export function deriveNotifications(input: DeriveInput): AppNotification[] {
  const high: AppNotification[] = [
    ...input.pending.filter((p) => p.request.status === 'pending' && !p.request.overdue).map((p) => reviewNotification(input.userId, p)),
    ...input.approved.map((d) => applyNotification(input.userId, d)).filter((n): n is AppNotification => n !== null),
  ].sort((a, b) => b.sortAt.localeCompare(a.sortAt))

  const medium = input.attention
    .map((i) => dueNotification(input.userId, i))
    .filter((n): n is AppNotification => n !== null)
    // Vencidos primero; luego por fecha relevante ascendente.
    .sort((a, b) => Number(b.counts) - Number(a.counts) || a.sortAt.localeCompare(b.sortAt))

  // Sin duplicados por clave (defensa: una misma revisión no debe aparecer dos veces).
  const seen = new Set<string>()
  return [...high, ...medium].filter((n) => (seen.has(n.key) ? false : (seen.add(n.key), true)))
}

export const badgeCount = (list: readonly AppNotification[]) => list.filter((n) => n.counts).length

/**
 * Qué avisos merecen un toast ahora. Regla anti-spam:
 *  - La PRIMERA carga solo establece la línea base: no se muestran como «nuevos» los pendientes
 *    históricos (a lo sumo un resumen único por sesión, decidido por el llamador).
 *  - Después, solo los avisos de prioridad alta cuya clave no se haya anunciado antes.
 */
export function newToastCandidates(list: readonly AppNotification[], announced: ReadonlySet<string>, baselineDone: boolean): AppNotification[] {
  if (!baselineDone) return []
  return list.filter((n) => n.priority === 'high' && !announced.has(n.key))
}
