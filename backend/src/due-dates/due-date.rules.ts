import { daysBetween } from './calendar.js';

/**
 * Reglas determinísticas de vencimiento. Funciones puras: el mismo registro,
 * con el mismo estado y la misma fecha de referencia, siempre produce el mismo
 * resultado. No modifican datos ni dependen del reloj del sistema.
 */

/** Umbrales operativos (ver `DUE_DATE_DEFAULTS` en la configuración). */
export interface DueDateRules {
  timeZone: string;
  obligationDays: number;
  rentChargeDays: number;
  contractDays: number;
  hitlSoonHours: number;
}

export const DUE_ITEM_KINDS = [
  'obligation_occurrence',
  'rent_charge',
  'contract',
  'hitl_request',
] as const;
export type DueItemKind = (typeof DUE_ITEM_KINDS)[number];

/**
 * - `scheduled`: abierto, pero fuera del umbral de aviso.
 * - `upcoming`: abierto y dentro del umbral (vence en 1..N días).
 * - `due_today`: vence hoy.
 * - `overdue`: la fecha pasó y sigue sin confirmación o atención.
 * - `resolved`: sin acción pendiente (confirmado, recibido, anulado, terminado).
 */
export const DUE_CONDITIONS = [
  'scheduled',
  'upcoming',
  'due_today',
  'overdue',
  'resolved',
] as const;
export type DueCondition = (typeof DUE_CONDITIONS)[number];

/** Condiciones de una revisión HITL (fecha límite con hora, no de calendario). */
export const HITL_CONDITIONS = [
  'pending',
  'due_soon',
  'overdue',
  'resolved',
] as const;
export type HitlCondition = (typeof HITL_CONDITIONS)[number];

/** Estados en los que todavía hay algo por atender. El resto es `resolved`. */
export const OPEN_STATUSES = {
  obligation_occurrence: ['pending', 'overdue'],
  rent_charge: ['expected', 'pending', 'overdue'],
  contract: ['active'],
  hitl_request: ['pending'],
} as const satisfies Record<DueItemKind, readonly string[]>;

export interface DueEvaluation {
  condition: DueCondition;
  /** Días hasta la fecha (negativo si ya pasó). */
  daysUntil: number;
  /** Días de retraso (0 si no está vencido o ya se resolvió). */
  daysOverdue: number;
  /** Umbral de aviso aplicado, en días. */
  windowDays: number;
  /** `upcoming`, `due_today` u `overdue`. */
  requiresAttention: boolean;
}

const ATTENTION_CONDITIONS = new Set<DueCondition>([
  'upcoming',
  'due_today',
  'overdue',
]);

/** Núcleo común: fecha de calendario frente a la fecha de referencia. */
export function evaluateDueDate(
  input: { dueDate: string; open: boolean; windowDays: number },
  today: string,
): DueEvaluation {
  const daysUntil = daysBetween(today, input.dueDate);
  let condition: DueCondition;
  if (!input.open) condition = 'resolved';
  else if (daysUntil < 0) condition = 'overdue';
  else if (daysUntil === 0) condition = 'due_today';
  else if (daysUntil <= input.windowDays) condition = 'upcoming';
  else condition = 'scheduled';
  return {
    condition,
    daysUntil,
    daysOverdue: condition === 'overdue' ? -daysUntil : 0,
    windowDays: input.windowDays,
    requiresAttention: ATTENTION_CONDITIONS.has(condition),
  };
}

export const isOpenStatus = (kind: DueItemKind, status: string) =>
  (OPEN_STATUSES[kind] as readonly string[]).includes(status);

/**
 * Umbral de un período: el mayor entre el valor del MVP y los
 * `reminder_days_before` de la obligación (conservador: nunca avisa más
 * tarde de lo que pidió el usuario ni de lo que fija el MVP).
 */
export function obligationWindow(
  rules: DueDateRules,
  reminderDaysBefore: number,
): number {
  return Math.max(rules.obligationDays, reminderDaysBefore);
}

/** Umbral de un contrato: el del MVP o el preaviso pactado, el mayor. */
export function contractWindow(
  rules: DueDateRules,
  noticePeriodDays: number | null,
): number {
  return Math.max(rules.contractDays, noticePeriodDays ?? 0);
}

export function evaluateOccurrence(
  row: { dueDate: string; status: string; reminderDaysBefore: number },
  rules: DueDateRules,
  today: string,
): DueEvaluation {
  return evaluateDueDate(
    {
      dueDate: row.dueDate,
      open: isOpenStatus('obligation_occurrence', row.status),
      windowDays: obligationWindow(rules, row.reminderDaysBefore),
    },
    today,
  );
}

/**
 * D6 (aprobada 7-nov-2026): ventana **personalizada**, solo para decidir si
 * se crea o se resuelve la alerta `obligation_due_soon`/`obligation_overdue`
 * de un período. A diferencia de {@link evaluateOccurrence} (que usa
 * `max(DUE_DATES_OBLIGATION_DAYS, reminderDaysBefore)` para la bandeja, el
 * KPI del dashboard y `condition`, sin cambios), aquí el umbral es
 * `reminderDaysBefore` solo: con 3, el aviso aparece 3 días antes, no 7.
 * `overdue` no depende del umbral, así que es idéntico en ambas.
 */
export function evaluateOccurrenceAlert(
  row: { dueDate: string; status: string; reminderDaysBefore: number },
  today: string,
): DueEvaluation {
  return evaluateDueDate(
    {
      dueDate: row.dueDate,
      open: isOpenStatus('obligation_occurrence', row.status),
      windowDays: row.reminderDaysBefore,
    },
    today,
  );
}

/** El valor del cobro no interviene: cambiar el canon no altera cobros ya registrados. */
export function evaluateRentCharge(
  row: { dueDate: string; status: string },
  rules: DueDateRules,
  today: string,
): DueEvaluation {
  return evaluateDueDate(
    {
      dueDate: row.dueDate,
      open: isOpenStatus('rent_charge', row.status),
      windowDays: rules.rentChargeDays,
    },
    today,
  );
}

/**
 * Un contrato `active` cuya fecha final pasó queda `overdue` (requiere
 * revisión humana): nunca se marca vencido, terminado ni renovado solo.
 */
export function evaluateContract(
  row: { endsOn: string; status: string; noticePeriodDays: number | null },
  rules: DueDateRules,
  today: string,
): DueEvaluation {
  return evaluateDueDate(
    {
      dueDate: row.endsOn,
      open: isOpenStatus('contract', row.status),
      windowDays: contractWindow(rules, row.noticePeriodDays),
    },
    today,
  );
}

export interface HitlEvaluation {
  condition: HitlCondition;
  /** Milisegundos hasta la fecha límite (negativo si pasó). */
  msLeft: number;
}

/** Una revisión vencida nunca equivale a aprobación: solo se informa. */
export function evaluateHitl(
  row: { status: string; dueAt: Date },
  rules: DueDateRules,
  now: Date,
): HitlEvaluation {
  const msLeft = row.dueAt.getTime() - now.getTime();
  let condition: HitlCondition;
  if (!isOpenStatus('hitl_request', row.status)) condition = 'resolved';
  else if (msLeft <= 0) condition = 'overdue';
  else if (msLeft <= rules.hitlSoonHours * 3_600_000) condition = 'due_soon';
  else condition = 'pending';
  return { condition, msLeft };
}

/**
 * Prioridad determinística de la bandeja (1 = más urgente). No es una
 * predicción: depende solo del tipo de elemento y de su condición.
 * 1. Revisiones HITL próximas a vencer o vencidas sin decisión.
 * 2. Períodos o cobros vencidos; contratos con fecha final superada.
 * 3. Vencimientos de hoy.
 * 4. Compromisos dentro del umbral y revisiones HITL con plazo holgado.
 */
export const ATTENTION_PRIORITIES = {
  hitl_overdue: 1,
  hitl_due_soon: 1,
  overdue: 2,
  due_today: 3,
  upcoming: 4,
  hitl_pending: 4,
} as const;
export type AttentionPriority =
  (typeof ATTENTION_PRIORITIES)[keyof typeof ATTENTION_PRIORITIES];

export function attentionPriority(
  kind: DueItemKind,
  condition: DueCondition | HitlCondition,
): AttentionPriority | null {
  if (kind === 'hitl_request') {
    if (condition === 'overdue') return ATTENTION_PRIORITIES.hitl_overdue;
    if (condition === 'due_soon') return ATTENTION_PRIORITIES.hitl_due_soon;
    if (condition === 'pending') return ATTENTION_PRIORITIES.hitl_pending;
    return null;
  }
  if (condition === 'overdue') return ATTENTION_PRIORITIES.overdue;
  if (condition === 'due_today') return ATTENTION_PRIORITIES.due_today;
  if (condition === 'upcoming') return ATTENTION_PRIORITIES.upcoming;
  return null;
}
