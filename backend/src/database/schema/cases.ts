import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, tstz } from './columns.js';
import { contracts } from './contracts.js';
import { documents } from './documents.js';
import {
  caseStatus,
  caseType,
  hitlDecisionType,
  hitlStatus,
  inputSource,
  proposalReviewStatus,
  proposalSource,
} from './enums.js';
import { obligations } from './obligations.js';
import { profiles } from './profiles.js';
import { rentals } from './rentals.js';

/**
 * Caso de procesamiento identificado por `correlation_id`.
 * El workflow decide las transiciones; la API persiste la representación autorizada.
 */
export const cases = pgTable(
  'cases',
  {
    id: id(),
    correlationId: uuid('correlation_id').notNull().unique().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    type: caseType('type').notNull(),
    source: inputSource('source').notNull(),
    status: caseStatus('status').notNull().default('received'),
    /** Entidad de negocio relacionada (como máximo una). */
    obligationId: uuid('obligation_id'),
    rentalId: uuid('rental_id'),
    contractId: uuid('contract_id'),
    /** Motivo de detención o error. */
    statusReason: text('status_reason'),
    closedAt: tstz('closed_at'),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('cases_id_owner_unique').on(t.id, t.ownerId),
    index('cases_owner_status_idx').on(t.ownerId, t.status),
    index('cases_obligation_idx').on(t.obligationId),
    index('cases_rental_idx').on(t.rentalId),
    index('cases_contract_idx').on(t.contractId),
    foreignKey({
      name: 'cases_obligation_owner_fk',
      columns: [t.obligationId, t.ownerId],
      foreignColumns: [obligations.id, obligations.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'cases_rental_owner_fk',
      columns: [t.rentalId, t.ownerId],
      foreignColumns: [rentals.id, rentals.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'cases_contract_owner_fk',
      columns: [t.contractId, t.ownerId],
      foreignColumns: [contracts.id, contracts.ownerId],
    }).onDelete('restrict'),
    check(
      'cases_single_subject',
      sql`num_nonnulls(${t.obligationId}, ${t.rentalId}, ${t.contractId}) <= 1`,
    ),
    check(
      'cases_failed_reason',
      sql`${t.status} <> 'failed' OR ${t.statusReason} IS NOT NULL`,
    ),
  ],
);

/**
 * Datos interpretados (IA, OCR, STT) pendientes de validación.
 * Son propuestas temporales: nunca se consideran información definitiva.
 */
export const caseProposals = pgTable(
  'case_proposals',
  {
    id: id(),
    caseId: uuid('case_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    version: integer('version').notNull().default(1),
    source: proposalSource('source').notNull(),
    proposedData: jsonb('proposed_data').notNull(),
    /** Evidencia mínima: fragmento de texto, página, campo de origen. */
    evidence: jsonb('evidence'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    documentId: uuid('document_id'),
    reviewStatus: proposalReviewStatus('review_status')
      .notNull()
      .default('pending_review'),
    reviewedAt: tstz('reviewed_at'),
    reviewedBy: uuid('reviewed_by').references(() => profiles.id, {
      onDelete: 'restrict',
    }),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('case_proposals_case_version_unique').on(t.caseId, t.version),
    unique('case_proposals_id_owner_unique').on(t.id, t.ownerId),
    index('case_proposals_document_idx').on(t.documentId),
    foreignKey({
      name: 'case_proposals_case_owner_fk',
      columns: [t.caseId, t.ownerId],
      foreignColumns: [cases.id, cases.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'case_proposals_document_owner_fk',
      columns: [t.documentId, t.ownerId],
      foreignColumns: [documents.id, documents.ownerId],
    }).onDelete('restrict'),
    check('case_proposals_version_positive', sql`${t.version} >= 1`),
    check(
      'case_proposals_confidence_range',
      sql`${t.confidence} BETWEEN 0 AND 1`,
    ),
    check(
      'case_proposals_review',
      sql`(${t.reviewStatus} IN ('accepted', 'rejected')) = (${t.reviewedAt} IS NOT NULL AND ${t.reviewedBy} IS NOT NULL)`,
    ),
  ],
);

/**
 * Solicitud de intervención humana. SLA inicial de 24 horas.
 * Una solicitud vencida (`expired`) nunca equivale a aprobación.
 */
export const hitlRequests = pgTable(
  'hitl_requests',
  {
    id: id(),
    caseId: uuid('case_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    proposalId: uuid('proposal_id'),
    /** Usuario autorizado para decidir. */
    assignedTo: uuid('assigned_to')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    decisionType: hitlDecisionType('decision_type').notNull(),
    status: hitlStatus('status').notNull().default('pending'),
    /** Alternativas presentadas o datos pendientes de confirmar. */
    options: jsonb('options').notNull().default({}),
    createdAt: tstz('created_at').notNull().defaultNow(),
    dueAt: tstz('due_at')
      .notNull()
      .default(sql`now() + interval '24 hours'`),
    decision: jsonb('decision'),
    respondedAt: tstz('responded_at'),
    evidenceReference: text('evidence_reference'),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t): PgTableExtraConfigValue[] => [
    index('hitl_requests_case_idx').on(t.caseId),
    index('hitl_requests_assignee_status_idx').on(t.assignedTo, t.status),
    index('hitl_requests_pending_due_idx')
      .on(t.dueAt)
      .where(sql`${t.status} = 'pending'`),
    foreignKey({
      name: 'hitl_requests_case_owner_fk',
      columns: [t.caseId, t.ownerId],
      foreignColumns: [cases.id, cases.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'hitl_requests_proposal_owner_fk',
      columns: [t.proposalId, t.ownerId],
      foreignColumns: [caseProposals.id, caseProposals.ownerId],
    }).onDelete('restrict'),
    check('hitl_requests_due_after_created', sql`${t.dueAt} > ${t.createdAt}`),
    // Solo hay decisión cuando el usuario respondió explícitamente.
    check(
      'hitl_requests_decision',
      sql`(${t.status} IN ('approved', 'rejected')) = (${t.decision} IS NOT NULL AND ${t.respondedAt} IS NOT NULL)`,
    ),
  ],
);
