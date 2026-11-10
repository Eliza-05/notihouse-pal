import {
  alertSeverity,
  alertState,
  alertType,
} from '../database/schema/index.js';
import type {
  DueCondition,
  DueItemKind,
  HitlCondition,
} from '../due-dates/due-date.rules.js';

export const ALERT_TYPES = alertType.enumValues;
export type AlertType = (typeof ALERT_TYPES)[number];
export const ALERT_SEVERITIES = alertSeverity.enumValues;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_STATES = alertState.enumValues;
export type AlertState = (typeof ALERT_STATES)[number];

/** Alerta que corresponde a un recurso según la evaluación de vencimientos. */
export interface DesiredAlert {
  kind: DueItemKind;
  resourceId: string;
  type: AlertType;
  severity: AlertSeverity;
  relevantDate: string;
  dedupKey: string;
}

/**
 * Condición del motor → tipo de alerta. Una condición sin entrada
 * (`scheduled`, `resolved`) no genera alerta.
 */
const TYPE_BY_CONDITION: Record<
  DueItemKind,
  Partial<Record<DueCondition | HitlCondition, AlertType>>
> = {
  obligation_occurrence: {
    upcoming: 'obligation_due_soon',
    due_today: 'obligation_due_soon',
    overdue: 'obligation_overdue',
  },
  rent_charge: {
    upcoming: 'rent_charge_due_soon',
    due_today: 'rent_charge_due_soon',
    overdue: 'rent_charge_overdue',
  },
  contract: {
    upcoming: 'contract_ending_soon',
    due_today: 'contract_ending_soon',
    overdue: 'contract_end_passed',
  },
  hitl_request: {
    pending: 'hitl_pending',
    due_soon: 'hitl_due_soon',
    overdue: 'hitl_overdue',
  },
};

export const ALERT_SEVERITY: Record<AlertType, AlertSeverity> = {
  obligation_due_soon: 'warning',
  obligation_overdue: 'critical',
  rent_charge_due_soon: 'warning',
  rent_charge_overdue: 'critical',
  contract_ending_soon: 'warning',
  contract_end_passed: 'critical',
  hitl_pending: 'warning',
  hitl_due_soon: 'critical',
  hitl_overdue: 'critical',
};

export const ALERT_TITLES: Record<AlertType, string> = {
  obligation_due_soon: 'Obligación próxima a vencer',
  obligation_overdue: 'Obligación vencida sin confirmar',
  rent_charge_due_soon: 'Cobro de arriendo próximo',
  rent_charge_overdue: 'Cobro de arriendo vencido sin recibir',
  contract_ending_soon: 'Contrato próximo a finalizar',
  contract_end_passed: 'Contrato con fecha de finalización superada',
  hitl_pending: 'Revisión humana pendiente',
  hitl_due_soon: 'Revisión humana próxima a vencer',
  hitl_overdue: 'Revisión humana vencida sin decisión',
};

const MESSAGES: Record<AlertType, (date: string) => string> = {
  obligation_due_soon: (d) =>
    `El período vence el ${d}. Confírmalo cuando lo pagues o atiendas.`,
  obligation_overdue: (d) =>
    `El período venció el ${d} y no tiene confirmación de pago o atención.`,
  rent_charge_due_soon: (d) =>
    `El cobro se espera el ${d}. Confírmalo solo cuando recibas el dinero.`,
  rent_charge_overdue: (d) =>
    `El cobro se esperaba el ${d} y no se ha confirmado su recepción.`,
  contract_ending_soon: (d) =>
    `El contrato finaliza el ${d}. No se renueva automáticamente.`,
  contract_end_passed: (d) =>
    `La fecha de finalización (${d}) ya pasó. Revisa el estado del contrato.`,
  hitl_pending: (d) => `Tienes una revisión pendiente con plazo hasta el ${d}.`,
  hitl_due_soon: (d) =>
    `La revisión vence pronto (${d}). Si vence, nunca se considera aprobada.`,
  hitl_overdue: () =>
    'El plazo de la revisión terminó sin decisión; no se aplicará nada.',
};

export const alertMessage = (type: AlertType, relevantDate: string) =>
  MESSAGES[type](relevantDate);

/** `tipo:recurso:fecha`. Un cambio de fecha o de etapa produce otra clave. */
export const alertDedupKey = (
  type: AlertType,
  resourceId: string,
  relevantDate: string,
) => `${type}:${resourceId}:${relevantDate}`;

export function desiredAlert(
  kind: DueItemKind,
  resourceId: string,
  relevantDate: string,
  condition: DueCondition | HitlCondition,
): DesiredAlert | null {
  const type = TYPE_BY_CONDITION[kind][condition];
  if (!type) return null;
  return {
    kind,
    resourceId,
    type,
    severity: ALERT_SEVERITY[type],
    relevantDate,
    dedupKey: alertDedupKey(type, resourceId, relevantDate),
  };
}
