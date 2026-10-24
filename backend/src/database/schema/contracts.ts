import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  type PgTableExtraConfigValue,
  smallint,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';
import { documents } from './documents.js';
import { contractStatus } from './enums.js';
import { profiles } from './profiles.js';
import { properties } from './properties.js';
import { rentals } from './rentals.js';

/** Contrato asociado a un inmueble (y opcionalmente a un arriendo). Sin renovación automática. */
export const contracts = pgTable(
  'contracts',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id').notNull(),
    rentalId: uuid('rental_id'),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    /** Días de preaviso pactados, para alertas determinísticas de vencimiento. */
    noticePeriodDays: smallint('notice_period_days'),
    status: contractStatus('status').notNull().default('active'),
    documentId: uuid('document_id'),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('contracts_id_owner_unique').on(t.id, t.ownerId),
    index('contracts_owner_ends_idx').on(t.ownerId, t.endsOn),
    index('contracts_property_idx').on(t.propertyId),
    index('contracts_rental_idx').on(t.rentalId),
    foreignKey({
      name: 'contracts_property_owner_fk',
      columns: [t.propertyId, t.ownerId],
      foreignColumns: [properties.id, properties.ownerId],
    }).onDelete('restrict'),
    // El arriendo, si existe, debe pertenecer al mismo inmueble y propietario.
    foreignKey({
      name: 'contracts_rental_property_owner_fk',
      columns: [t.rentalId, t.propertyId, t.ownerId],
      foreignColumns: [rentals.id, rentals.propertyId, rentals.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_document_owner_fk',
      columns: [t.documentId, t.ownerId],
      foreignColumns: [documents.id, documents.ownerId],
    }).onDelete('restrict'),
    check('contracts_date_order', sql`${t.endsOn} >= ${t.startsOn}`),
    check(
      'contracts_notice_period_range',
      sql`${t.noticePeriodDays} BETWEEN 0 AND 365`,
    ),
  ],
);
