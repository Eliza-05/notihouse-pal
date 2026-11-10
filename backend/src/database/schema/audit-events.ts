import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, tstz } from './columns.js';
import { auditActorType, auditResult } from './enums.js';
import { profiles } from './profiles.js';

/**
 * Registro append-only. La migración inicial añade un trigger que rechaza
 * UPDATE, DELETE y TRUNCATE sobre esta tabla.
 * `correlation_id` no es FK: debe poder registrar eventos previos a la
 * creación del caso o de componentes externos.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    correlationId: uuid('correlation_id'),
    ownerId: uuid('owner_id').references(() => profiles.id, {
      onDelete: 'restrict',
    }),
    actorType: auditActorType('actor_type').notNull(),
    actorId: text('actor_id'),
    component: text('component').notNull(),
    action: text('action').notNull(),
    result: auditResult('result').notNull(),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
    evidenceReference: text('evidence_reference'),
    /** Metadatos mínimos; nunca credenciales ni documentos completos. */
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => [
    index('audit_events_correlation_idx').on(t.correlationId),
    index('audit_events_owner_occurred_idx').on(t.ownerId, t.occurredAt),
  ],
);
