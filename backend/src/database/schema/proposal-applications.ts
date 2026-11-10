import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  pgTable,
  type PgTableExtraConfigValue,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { caseProposals, cases, hitlRequests } from './cases.js';
import { id, tstz } from './columns.js';
import { proposalApplicationAction } from './enums.js';
import { obligationOccurrences, obligations } from './obligations.js';
import { profiles } from './profiles.js';
import { rentals } from './rentals.js';

/**
 * Registro inequívoco de que una propuesta aprobada se aplicó a los datos de
 * negocio. `proposal_id` es único: una propuesta se aplica como máximo una
 * vez, aunque lleguen reintentos o solicitudes simultáneas.
 * Las acciones permitidas solo crean o editan registros `pending`/vigentes:
 * nunca confirman pagos, cobros ni contratos.
 *
 * El recurso de la aplicación es exactamente uno de tres (D8, migración
 * 0004): un período (`obligationId` + `occurrenceId`, las dos acciones
 * originales y `update_occurrence_details`), una obligación sin período
 * propio (`obligationId` solo, `update_obligation_schedule` y
 * `create_recurring_obligation`) o un arriendo (`rentalId` solo,
 * `create_recurring_rental`).
 */
export const proposalApplications = pgTable(
  'proposal_applications',
  {
    id: id(),
    proposalId: uuid('proposal_id').notNull(),
    caseId: uuid('case_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    /** Revisión humana aprobada que autorizó la aplicación. */
    hitlRequestId: uuid('hitl_request_id')
      .notNull()
      .references(() => hitlRequests.id, { onDelete: 'restrict' }),
    action: proposalApplicationAction('action').notNull(),
    /** Obligación usada, creada o editada (ausente para `create_recurring_rental`). */
    obligationId: uuid('obligation_id'),
    /** Período creado o editado (ausente cuando la acción no toca un período). */
    occurrenceId: uuid('occurrence_id').references(
      () => obligationOccurrences.id,
      { onDelete: 'restrict' },
    ),
    /** Arriendo creado (solo `create_recurring_rental`). */
    rentalId: uuid('rental_id'),
    appliedBy: uuid('applied_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    appliedAt: tstz('applied_at').notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('proposal_applications_proposal_unique').on(t.proposalId),
    // Postgres no cuenta NULL como duplicado: las aplicaciones sobre una
    // obligación sola o un arriendo (occurrence_id nulo) no chocan entre sí.
    // `update_occurrence_details` no puede dirigirse a un período que ya
    // tenga otra aplicación (caso excepcional; el uso previsto son períodos
    // generados por recurrencia, sin aplicación previa).
    unique('proposal_applications_occurrence_unique').on(t.occurrenceId),
    foreignKey({
      name: 'proposal_applications_proposal_owner_fk',
      columns: [t.proposalId, t.ownerId],
      foreignColumns: [caseProposals.id, caseProposals.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposal_applications_case_owner_fk',
      columns: [t.caseId, t.ownerId],
      foreignColumns: [cases.id, cases.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposal_applications_obligation_owner_fk',
      columns: [t.obligationId, t.ownerId],
      foreignColumns: [obligations.id, obligations.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposal_applications_rental_owner_fk',
      columns: [t.rentalId, t.ownerId],
      foreignColumns: [rentals.id, rentals.ownerId],
    }).onDelete('restrict'),
    // Solo el propietario aplica sus propias propuestas.
    check(
      'proposal_applications_applied_by_owner',
      sql`${t.appliedBy} = ${t.ownerId}`,
    ),
    // Exactamente un recurso: período, obligación sola, o arriendo (D8).
    check(
      'proposal_applications_exactly_one_resource',
      sql`(
        (${t.obligationId} IS NOT NULL AND ${t.occurrenceId} IS NOT NULL AND ${t.rentalId} IS NULL)
        OR (${t.obligationId} IS NOT NULL AND ${t.occurrenceId} IS NULL AND ${t.rentalId} IS NULL)
        OR (${t.obligationId} IS NULL AND ${t.occurrenceId} IS NULL AND ${t.rentalId} IS NOT NULL)
      )`,
    ),
  ],
);
