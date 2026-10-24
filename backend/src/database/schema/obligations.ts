import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { currency, id, money, timestamps, tstz } from './columns.js';
import {
  obligationCategory,
  obligationStatus,
  occurrenceStatus,
  recurrenceFrequency,
} from './enums.js';
import { profiles } from './profiles.js';
import { properties } from './properties.js';
import { providers } from './providers.js';

/** Definición de una obligación recurrente. Sus períodos concretos viven en `obligation_occurrences`. */
export const obligations = pgTable(
  'obligations',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id'),
    /** Proveedor del catálogo; necesario para presentar enlaces oficiales de pago. */
    providerId: uuid('provider_id').references(() => providers.id, {
      onDelete: 'restrict',
    }),
    /** Nombre del proveedor tal como lo registra el usuario. */
    providerName: text('provider_name').notNull(),
    concept: text('concept').notNull(),
    category: obligationCategory('category').notNull(),
    expectedAmount: money('expected_amount'),
    currency: currency(),
    frequency: recurrenceFrequency('frequency').notNull().default('monthly'),
    /** Día de vencimiento dentro del período (en meses cortos se ajusta al último día). */
    dueDay: smallint('due_day'),
    reminderDaysBefore: smallint('reminder_days_before').notNull().default(3),
    startsOn: date('starts_on', { mode: 'string' }),
    status: obligationStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    unique('obligations_id_owner_unique').on(t.id, t.ownerId),
    index('obligations_owner_idx').on(t.ownerId),
    index('obligations_property_idx').on(t.propertyId),
    index('obligations_provider_idx').on(t.providerId),
    foreignKey({
      name: 'obligations_property_owner_fk',
      columns: [t.propertyId, t.ownerId],
      foreignColumns: [properties.id, properties.ownerId],
    }).onDelete('restrict'),
    check(
      'obligations_expected_amount_non_negative',
      sql`${t.expectedAmount} >= 0`,
    ),
    check('obligations_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('obligations_due_day_range', sql`${t.dueDay} BETWEEN 1 AND 31`),
    check(
      'obligations_reminder_days_range',
      sql`${t.reminderDaysBefore} BETWEEN 0 AND 60`,
    ),
  ],
);

/** Período concreto de una obligación. Conserva el histórico; nunca se sobrescribe. */
export const obligationOccurrences = pgTable(
  'obligation_occurrences',
  {
    id: id(),
    obligationId: uuid('obligation_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    amount: money('amount'),
    currency: currency(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    status: occurrenceStatus('status').notNull().default('pending'),
    confirmedAt: tstz('confirmed_at'),
    confirmedBy: uuid('confirmed_by').references(() => profiles.id, {
      onDelete: 'restrict',
    }),
    /** Referencia aportada por el usuario (número de comprobante, nota). */
    confirmationReference: text('confirmation_reference'),
    ...timestamps(),
  },
  (t) => [
    unique('obligation_occurrences_period_unique').on(
      t.obligationId,
      t.periodStart,
    ),
    index('obligation_occurrences_owner_due_idx').on(t.ownerId, t.dueDate),
    index('obligation_occurrences_open_due_idx')
      .on(t.dueDate)
      .where(sql`${t.status} IN ('pending', 'overdue')`),
    foreignKey({
      name: 'obligation_occurrences_obligation_owner_fk',
      columns: [t.obligationId, t.ownerId],
      foreignColumns: [obligations.id, obligations.ownerId],
    }).onDelete('restrict'),
    check(
      'obligation_occurrences_period_order',
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
    check('obligation_occurrences_amount_non_negative', sql`${t.amount} >= 0`),
    check(
      'obligation_occurrences_currency_format',
      sql`${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    // Nunca se asume un pago: pagada/atendida <=> confirmación humana registrada.
    check(
      'obligation_occurrences_confirmation',
      sql`(${t.status} IN ('paid', 'attended')) = (${t.confirmedAt} IS NOT NULL AND ${t.confirmedBy} IS NOT NULL)`,
    ),
  ],
);
