import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { hitlRequests } from './cases.js';
import { id, timestamps, tstz } from './columns.js';
import { contracts } from './contracts.js';
import {
  alertResolution,
  alertSeverity,
  alertState,
  alertType,
} from './enums.js';
import { obligationOccurrences } from './obligations.js';
import { profiles } from './profiles.js';
import { rentCharges } from './rentals.js';

/**
 * Alerta interna generada por la evaluación determinística de vencimientos.
 * Solo se muestra dentro de la plataforma: no representa ningún envío push,
 * correo ni mensaje a terceros. No copia montos ni datos del recurso: se
 * consultan siempre en la entidad original. El historial no se borra.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    type: alertType('type').notNull(),
    severity: alertSeverity('severity').notNull(),
    /** Recurso relacionado: exactamente una de estas cuatro columnas. */
    occurrenceId: uuid('occurrence_id').references(
      () => obligationOccurrences.id,
      { onDelete: 'restrict' },
    ),
    rentChargeId: uuid('rent_charge_id').references(() => rentCharges.id, {
      onDelete: 'restrict',
    }),
    contractId: uuid('contract_id').references(() => contracts.id, {
      onDelete: 'restrict',
    }),
    hitlRequestId: uuid('hitl_request_id').references(() => hitlRequests.id, {
      onDelete: 'restrict',
    }),
    /** Fecha de calendario que originó la alerta (vencimiento, fin de contrato, límite HITL). */
    relevantDate: date('relevant_date', { mode: 'string' }).notNull(),
    /** `tipo:recurso:fecha`: la misma situación nunca produce dos alertas. */
    dedupKey: text('dedup_key').notNull(),
    state: alertState('state').notNull().default('active'),
    readAt: tstz('read_at'),
    dismissedAt: tstz('dismissed_at'),
    resolvedAt: tstz('resolved_at'),
    resolutionReason: alertResolution('resolution_reason'),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('alerts_owner_dedup_unique').on(t.ownerId, t.dedupKey),
    index('alerts_owner_created_idx').on(t.ownerId, t.createdAt),
    // Como máximo una alerta activa por recurso: dos avisos contradictorios
    // sobre el mismo período, cobro, contrato o revisión son imposibles.
    uniqueIndex('alerts_active_occurrence_unique')
      .on(t.occurrenceId)
      .where(sql`${t.state} = 'active' AND ${t.occurrenceId} IS NOT NULL`),
    uniqueIndex('alerts_active_rent_charge_unique')
      .on(t.rentChargeId)
      .where(sql`${t.state} = 'active' AND ${t.rentChargeId} IS NOT NULL`),
    uniqueIndex('alerts_active_contract_unique')
      .on(t.contractId)
      .where(sql`${t.state} = 'active' AND ${t.contractId} IS NOT NULL`),
    uniqueIndex('alerts_active_hitl_request_unique')
      .on(t.hitlRequestId)
      .where(sql`${t.state} = 'active' AND ${t.hitlRequestId} IS NOT NULL`),
    check(
      'alerts_single_resource',
      sql`num_nonnulls(${t.occurrenceId}, ${t.rentChargeId}, ${t.contractId}, ${t.hitlRequestId}) = 1`,
    ),
    check('alerts_dedup_key_length', sql`length(${t.dedupKey}) <= 200`),
    check(
      'alerts_dismissed',
      sql`(${t.state} = 'dismissed') = (${t.dismissedAt} IS NOT NULL)`,
    ),
    check(
      'alerts_resolved',
      sql`(${t.state} = 'resolved') = (${t.resolvedAt} IS NOT NULL AND ${t.resolutionReason} IS NOT NULL)`,
    ),
  ],
);
