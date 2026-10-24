import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { cases } from './cases.js';
import { id, timestamps, tstz } from './columns.js';
import { jobStatus } from './enums.js';

/**
 * Cola persistente consultada por n8n mediante la API (modelo pull).
 * La reclamación futura usará `FOR UPDATE SKIP LOCKED` y un arrendamiento
 * temporal (`locked_by`, `locked_until`) para evitar procesamiento duplicado.
 */
export const workflowJobs = pgTable(
  'workflow_jobs',
  {
    id: id(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'restrict' }),
    jobType: text('job_type').notNull(),
    status: jobStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** Referencias mínimas para ejecutar el trabajo; sin credenciales. */
    payload: jsonb('payload').notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    availableAt: tstz('available_at').notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedUntil: tstz('locked_until'),
    result: jsonb('result'),
    lastError: text('last_error'),
    completedAt: tstz('completed_at'),
    ...timestamps(),
  },
  (t) => [
    index('workflow_jobs_case_idx').on(t.caseId),
    // Selección eficiente de trabajos listos para reclamar.
    index('workflow_jobs_pending_available_idx')
      .on(t.availableAt)
      .where(sql`${t.status} = 'pending'`),
    // Detección de arrendamientos vencidos.
    index('workflow_jobs_claimed_lease_idx')
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'claimed'`),
    check(
      'workflow_jobs_job_type_format',
      sql`${t.jobType} ~ '^[a-z][a-z0-9_.]*$'`,
    ),
    check(
      'workflow_jobs_attempts_range',
      sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1 AND ${t.attempts} <= ${t.maxAttempts}`,
    ),
    check(
      'workflow_jobs_lease',
      sql`(${t.status} = 'claimed') = (${t.lockedBy} IS NOT NULL AND ${t.lockedUntil} IS NOT NULL)`,
    ),
    check(
      'workflow_jobs_completed_at',
      sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
  ],
);
