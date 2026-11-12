/**
 * Etiquetas de interfaz para los valores reales que devuelve la API
 * (§4 de la guía). Los valores de la izquierda son los únicos que existen;
 * el texto de la derecha es la propuesta de esta implementación.
 */

export const PROPERTY_STATUS_LABELS: Record<string, string> = {
  active: 'Activo',
  inactive: 'Inactivo',
  archived: 'Archivado',
}

export const OBLIGATION_CATEGORY_LABELS: Record<string, string> = {
  water: 'Agua',
  electricity: 'Energía',
  gas: 'Gas',
  internet: 'Internet',
  mobile: 'Celular',
  administration: 'Administración',
  other: 'Otra',
}

export const OBLIGATION_FREQUENCY_LABELS: Record<string, string> = {
  monthly: 'Mensual',
  bimonthly: 'Bimestral',
  quarterly: 'Trimestral',
  semiannual: 'Semestral',
  annual: 'Anual',
}

export const OBLIGATION_STATUS_LABELS: Record<string, string> = {
  active: 'Activa',
  paused: 'Pausada',
  archived: 'Archivada',
}

export const OCCURRENCE_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  overdue: 'Vencido',
  paid: 'Pagado',
  attended: 'Atendido',
  cancelled: 'Anulado',
}

export const RENTAL_STATUS_LABELS: Record<string, string> = {
  active: 'Vigente',
  suspended: 'Suspendido',
  ended: 'Terminado',
}

export const CHARGE_STATUS_LABELS: Record<string, string> = {
  expected: 'Esperado',
  pending: 'Pendiente',
  overdue: 'Vencido',
  received: 'Recibido',
  cancelled: 'Anulado',
}

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  active: 'Vigente',
  expired: 'Vencido',
  terminated: 'Terminado',
}

export const CASE_TYPE_LABELS: Record<string, string> = {
  household_obligation: 'Obligación del hogar',
  rent_collection: 'Cobro de arriendo',
  contract_review: 'Revisión de contrato',
}

export const SOURCE_LABELS: Record<string, string> = {
  form: 'Formulario',
  document: 'Documento',
  gmail: 'Correo',
  voice: 'Voz',
}

export const CASE_STATUS_LABELS: Record<string, string> = {
  received: 'Recibido (en cola)',
  processing: 'En proceso',
  awaiting_human: 'Esperando tu decisión',
  completed: 'Cerrado',
  failed: 'Fallido',
  cancelled: 'Cancelado',
}

export const DOCUMENT_SOURCE_LABELS: Record<string, string> = {
  document: 'Subido por ti',
  gmail: 'Correo',
  voice: 'Nota de voz',
  form: 'Formulario',
  text: 'Asistente',
}

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  invoice: 'Factura',
  contract: 'Contrato',
  payment_receipt: 'Comprobante de pago',
  voice_note: 'Nota de voz',
  other: 'Otro',
}

export const PROPOSAL_REVIEW_STATUS_LABELS: Record<string, string> = {
  pending_review: 'Por revisar',
  accepted: 'Aceptada',
  rejected: 'Rechazada',
  superseded: 'Reemplazada',
}

export const HITL_DECISION_TYPE_LABELS: Record<string, string> = {
  data_confirmation: 'Confirmar datos',
  conflict_resolution: 'Resolver conflicto',
  reminder_approval: 'Aprobar recordatorio',
  contract_review: 'Revisar contrato',
  other: 'Otra decisión',
}

export const HITL_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  expired: 'Vencida',
  cancelled: 'Anulada',
}

export const ALERT_TYPE_LABELS: Record<string, string> = {
  obligation_due_soon: 'Obligación próxima a vencer',
  obligation_overdue: 'Obligación vencida',
  rent_charge_due_soon: 'Cobro de arriendo próximo',
  rent_charge_overdue: 'Cobro de arriendo vencido',
  contract_ending_soon: 'Contrato próximo a terminar',
  contract_end_passed: 'Contrato con fecha de fin superada',
  hitl_pending: 'Revisión pendiente',
  hitl_due_soon: 'Revisión por vencer',
  hitl_overdue: 'Revisión vencida',
}

export const ALERT_SEVERITY_LABELS: Record<string, string> = {
  info: 'Información',
  warning: 'Aviso',
  critical: 'Crítica',
}

export const ALERT_STATE_LABELS: Record<string, string> = {
  active: 'Vigente',
  dismissed: 'Descartada',
  resolved: 'Resuelta',
}

export const ATTENTION_CONDITION_LABELS: Record<string, string> = {
  upcoming: 'Próximo',
  due_today: 'Vence hoy',
  overdue: 'Vencido',
  pending: 'Revisión pendiente',
  due_soon: 'Revisión por vencer',
}

export const SUGGESTED_ACTION_LABELS: Record<string, string> = {
  confirm_payment: 'Confirmar pago',
  confirm_receipt: 'Confirmar recepción',
  review_contract: 'Revisar contrato',
  decide_review: 'Decidir',
  view_review: 'Ver revisión',
}

export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return '—'
  return map[value] ?? value
}
