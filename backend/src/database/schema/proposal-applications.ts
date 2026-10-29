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

/**
 * Registro inequívoco de que una propuesta aprobada se aplicó a los datos de
 * negocio. `proposal_id` es único: una propuesta se aplica como máximo una
 * vez, aunque lleguen reintentos o solicitudes simultáneas.
 * Las acciones permitidas solo crean registros `pending`: nunca confirman
 * pagos, cobros ni contratos.
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
    /** Obligación usada o creada. */
    obligationId: uuid('obligation_id').notNull(),
    /** Período creado (siempre `pending`). */
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => obligationOccurrences.id, { onDelete: 'restrict' }),
    appliedBy: uuid('applied_by')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    appliedAt: tstz('applied_at').notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('proposal_applications_proposal_unique').on(t.proposalId),
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
    // Solo el propietario aplica sus propias propuestas.
    check(
      'proposal_applications_applied_by_owner',
      sql`${t.appliedBy} = ${t.ownerId}`,
    ),
  ],
);
