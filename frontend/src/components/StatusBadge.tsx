type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

/** Insignia de estado: siempre texto + color (nunca solo color, §10.3). */
export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return <span className={`badge badge-${tone}`}>{label}</span>
}

const TONE_BY_OCCURRENCE_STATUS: Record<string, Tone> = {
  pending: 'neutral',
  overdue: 'danger',
  paid: 'success',
  attended: 'success',
  cancelled: 'neutral',
}

const TONE_BY_CHARGE_STATUS: Record<string, Tone> = {
  expected: 'neutral',
  pending: 'warning',
  overdue: 'danger',
  received: 'success',
  cancelled: 'neutral',
}

const TONE_BY_CONTRACT_STATUS: Record<string, Tone> = {
  active: 'success',
  expired: 'danger',
  terminated: 'neutral',
}

const TONE_BY_RENTAL_STATUS: Record<string, Tone> = {
  active: 'success',
  suspended: 'warning',
  ended: 'neutral',
}

const TONE_BY_OBLIGATION_STATUS: Record<string, Tone> = {
  active: 'success',
  paused: 'warning',
  archived: 'neutral',
}

const TONE_BY_PROPERTY_STATUS: Record<string, Tone> = {
  active: 'success',
  inactive: 'warning',
  archived: 'neutral',
}

const TONE_BY_CASE_STATUS: Record<string, Tone> = {
  received: 'neutral',
  processing: 'info',
  awaiting_human: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

const TONE_BY_HITL_STATUS: Record<string, Tone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  expired: 'danger',
  cancelled: 'neutral',
}

const TONE_BY_ALERT_SEVERITY: Record<string, Tone> = {
  info: 'info',
  warning: 'warning',
  critical: 'danger',
}

export const toneFor = {
  occurrence: (s: string) => TONE_BY_OCCURRENCE_STATUS[s] ?? 'neutral',
  charge: (s: string) => TONE_BY_CHARGE_STATUS[s] ?? 'neutral',
  contract: (s: string) => TONE_BY_CONTRACT_STATUS[s] ?? 'neutral',
  rental: (s: string) => TONE_BY_RENTAL_STATUS[s] ?? 'neutral',
  obligation: (s: string) => TONE_BY_OBLIGATION_STATUS[s] ?? 'neutral',
  property: (s: string) => TONE_BY_PROPERTY_STATUS[s] ?? 'neutral',
  case: (s: string) => TONE_BY_CASE_STATUS[s] ?? 'neutral',
  hitl: (s: string) => TONE_BY_HITL_STATUS[s] ?? 'neutral',
  alertSeverity: (s: string) => TONE_BY_ALERT_SEVERITY[s] ?? 'neutral',
}
