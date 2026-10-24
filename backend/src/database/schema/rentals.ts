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
import { rentalStatus, rentChargeStatus } from './enums.js';
import { profiles } from './profiles.js';
import { properties } from './properties.js';

export const rentals = pgTable(
  'rentals',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id').notNull(),
    /** Alias del arrendatario; se evita almacenar datos personales innecesarios. */
    tenantAlias: text('tenant_alias'),
    expectedAmount: money('expected_amount').notNull(),
    currency: currency(),
    dueDay: smallint('due_day').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }),
    status: rentalStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    unique('rentals_id_owner_unique').on(t.id, t.ownerId),
    // Permite que los contratos verifiquen que arriendo e inmueble coinciden.
    unique('rentals_id_property_owner_unique').on(
      t.id,
      t.propertyId,
      t.ownerId,
    ),
    index('rentals_owner_idx').on(t.ownerId),
    index('rentals_property_idx').on(t.propertyId),
    foreignKey({
      name: 'rentals_property_owner_fk',
      columns: [t.propertyId, t.ownerId],
      foreignColumns: [properties.id, properties.ownerId],
    }).onDelete('restrict'),
    check('rentals_expected_amount_positive', sql`${t.expectedAmount} > 0`),
    check('rentals_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('rentals_due_day_range', sql`${t.dueDay} BETWEEN 1 AND 31`),
    check('rentals_date_order', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);

/** Cobro de arriendo de un período. Nunca pasa a `received` por el solo paso del tiempo. */
export const rentCharges = pgTable(
  'rent_charges',
  {
    id: id(),
    rentalId: uuid('rental_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    expectedAmount: money('expected_amount').notNull(),
    currency: currency(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    status: rentChargeStatus('status').notNull().default('expected'),
    confirmedAt: tstz('confirmed_at'),
    confirmedBy: uuid('confirmed_by').references(() => profiles.id, {
      onDelete: 'restrict',
    }),
    /** Evidencia mínima de recepción (referencia de transferencia, nota del propietario). */
    confirmationEvidence: text('confirmation_evidence'),
    ...timestamps(),
  },
  (t) => [
    unique('rent_charges_period_unique').on(t.rentalId, t.periodStart),
    index('rent_charges_owner_due_idx').on(t.ownerId, t.dueDate),
    index('rent_charges_open_due_idx')
      .on(t.dueDate)
      .where(sql`${t.status} IN ('expected', 'pending', 'overdue')`),
    foreignKey({
      name: 'rent_charges_rental_owner_fk',
      columns: [t.rentalId, t.ownerId],
      foreignColumns: [rentals.id, rentals.ownerId],
    }).onDelete('restrict'),
    check('rent_charges_period_order', sql`${t.periodEnd} >= ${t.periodStart}`),
    check(
      'rent_charges_expected_amount_positive',
      sql`${t.expectedAmount} > 0`,
    ),
    check('rent_charges_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'rent_charges_confirmation',
      sql`(${t.status} = 'received') = (${t.confirmedAt} IS NOT NULL AND ${t.confirmedBy} IS NOT NULL AND ${t.confirmationEvidence} IS NOT NULL)`,
    ),
  ],
);
