import type { HitlDetail } from '../../lib/api/types'
import type { ParsedProposal } from './proposalSchema'
import { reviewMode, type ReviewMode } from './reviewMode'

/**
 * Estado REAL de una revisión, tal como lo vive la persona. Aprobar y aplicar son pasos
 * distintos y `case.status = completed` NO significa «aplicada» (el flujo de cierre puede
 * terminar antes de que se aplique): el dato fiable es `proposal.appliedAt`.
 */
export type ReviewStage =
  | 'pending' //               esperando tu decisión
  | 'approved_pending_apply' // aprobada; falta aplicar (appliedAt === null)
  | 'approved_apply_unknown' // aprobada; el backend aún no informa si se aplicó
  | 'applied' //               aplicada a tus datos
  | 'acknowledged' //          informativa: ya la viste, no había nada que aplicar
  | 'choice_recorded' //       elegiste una alternativa; nada se ejecuta solo
  | 'rejected'
  | 'expired'
  | 'cancelled'

export interface ReviewStageInfo {
  stage: ReviewStage
  mode: ReviewMode
  /** Texto corto para insignias. */
  badge: string
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
}

export function reviewStage(
  hitl: Pick<HitlDetail, 'status' | 'overdue' | 'decisionType' | 'options' | 'proposal'>,
  parsed: ParsedProposal | null,
  /** true cuando en esta sesión ya se aplicó con éxito (respuesta de POST …/apply). */
  appliedLocally = false,
): ReviewStageInfo {
  const mode = reviewMode(hitl, parsed)
  const make = (stage: ReviewStage, badge: string, tone: ReviewStageInfo['tone']): ReviewStageInfo => ({ stage, mode, badge, tone })

  switch (hitl.status) {
    case 'pending':
      return hitl.overdue ? make('expired', 'Vencida', 'danger') : make('pending', 'Pendiente de tu revisión', 'warning')
    case 'rejected':
      return make('rejected', 'Rechazada', 'danger')
    case 'expired':
      return make('expired', 'Vencida', 'danger')
    case 'cancelled':
      return make('cancelled', 'Anulada', 'neutral')
    case 'approved': {
      if (mode === 'informational') return make('acknowledged', 'Revisada', 'success')
      if (mode === 'choice') return make('choice_recorded', 'Elección registrada', 'success')
      const appliedAt = hitl.proposal?.appliedAt
      if (appliedLocally || (typeof appliedAt === 'string' && appliedAt)) return make('applied', 'Aplicada', 'success')
      if (appliedAt === null) return make('approved_pending_apply', 'Aprobada, falta aplicar', 'info')
      return make('approved_apply_unknown', 'Aprobada', 'info')
    }
    default:
      return make('pending', 'Pendiente', 'neutral')
  }
}
