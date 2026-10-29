import { pgEnum } from 'drizzle-orm/pg-core';

// Estados controlados. Agregar valores en el futuro es una operación aditiva
// (ALTER TYPE ... ADD VALUE); eliminarlos requiere una migración revisada.

export const recordStatus = pgEnum('record_status', [
  'active',
  'inactive',
  'archived',
]);

export const obligationCategory = pgEnum('obligation_category', [
  'water',
  'electricity',
  'gas',
  'internet',
  'mobile',
  'administration',
  'other',
]);

export const recurrenceFrequency = pgEnum('recurrence_frequency', [
  'monthly',
  'bimonthly',
  'quarterly',
  'semiannual',
  'annual',
]);

export const obligationStatus = pgEnum('obligation_status', [
  'active',
  'paused',
  'archived',
]);

/** `paid` y `attended` solo son válidos con confirmación humana registrada. */
export const occurrenceStatus = pgEnum('occurrence_status', [
  'pending',
  'overdue',
  'paid',
  'attended',
  'cancelled',
]);

export const rentalStatus = pgEnum('rental_status', [
  'active',
  'suspended',
  'ended',
]);

/** `received` solo es válido con confirmación humana y evidencia. */
export const rentChargeStatus = pgEnum('rent_charge_status', [
  'expected',
  'pending',
  'overdue',
  'received',
  'cancelled',
]);

export const contractStatus = pgEnum('contract_status', [
  'active',
  'expired',
  'terminated',
]);

/** Proceso de negocio al que pertenece un caso. */
export const caseType = pgEnum('case_type', [
  'household_obligation',
  'rent_collection',
  'contract_review',
]);

/** Canal por el que ingresa la información. */
export const inputSource = pgEnum('input_source', [
  'form',
  'document',
  'gmail',
  'voice',
]);

export const caseStatus = pgEnum('case_status', [
  'received',
  'processing',
  'awaiting_human',
  'completed',
  'failed',
  'cancelled',
]);

export const documentType = pgEnum('document_type', [
  'invoice',
  'contract',
  'payment_receipt',
  'voice_note',
  'other',
]);

export const proposalSource = pgEnum('proposal_source', [
  'llm',
  'ocr',
  'stt',
  'user',
]);

export const proposalReviewStatus = pgEnum('proposal_review_status', [
  'pending_review',
  'accepted',
  'rejected',
  'superseded',
]);

export const hitlDecisionType = pgEnum('hitl_decision_type', [
  'data_confirmation',
  'conflict_resolution',
  'reminder_approval',
  'contract_review',
  'other',
]);

/** `expired` (SLA vencido) nunca equivale a aprobación. */
export const hitlStatus = pgEnum('hitl_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);

export const jobStatus = pgEnum('job_status', [
  'pending',
  'claimed',
  'completed',
  'failed',
  'cancelled',
]);

export const auditActorType = pgEnum('audit_actor_type', [
  'user',
  'api',
  'workflow',
  'agent',
  'system',
]);

export const auditResult = pgEnum('audit_result', [
  'success',
  'failure',
  'denied',
]);

export const linkValidationStatus = pgEnum('link_validation_status', [
  'pending',
  'validated',
  'rejected',
  'revoked',
]);

/** Situaciones que generan una alerta interna (nunca una notificación externa). */
export const alertType = pgEnum('alert_type', [
  'obligation_due_soon',
  'obligation_overdue',
  'rent_charge_due_soon',
  'rent_charge_overdue',
  'contract_ending_soon',
  'contract_end_passed',
  'hitl_pending',
  'hitl_due_soon',
  'hitl_overdue',
]);

export const alertSeverity = pgEnum('alert_severity', [
  'info',
  'warning',
  'critical',
]);

/** `dismissed` lo decide el usuario; `resolved` lo decide la evaluación. */
export const alertState = pgEnum('alert_state', [
  'active',
  'dismissed',
  'resolved',
]);

export const alertResolution = pgEnum('alert_resolution', [
  /** El recurso ya no tiene acción pendiente (confirmado, recibido, anulado, decidido). */
  'resource_closed',
  /** Otra alerta la reemplazó (escalamiento o cambio de fecha). */
  'superseded',
  /** El recurso sigue abierto pero salió del umbral de aviso. */
  'no_longer_applicable',
]);

/** Operaciones que una propuesta aprobada puede ejecutar (lista cerrada). */
export const proposalApplicationAction = pgEnum('proposal_application_action', [
  'create_obligation_occurrence',
  'create_obligation_with_occurrence',
]);
