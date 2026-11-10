import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { cases } from './cases.js';
import { id, timestamps } from './columns.js';
import { documentType, inputSource } from './enums.js';
import { profiles } from './profiles.js';

/** Metadatos de archivos. El contenido vive en almacenamiento privado, nunca en PostgreSQL. */
export const documents = pgTable(
  'documents',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    caseId: uuid('case_id'),
    type: documentType('type').notNull(),
    source: inputSource('source').notNull(),
    mimeType: text('mime_type').notNull(),
    fileName: text('file_name'),
    /** Clave del objeto en el almacenamiento privado. */
    storageKey: text('storage_key').notNull().unique(),
    sha256: char('sha256', { length: 64 }),
    /** Identificador del mensaje de Gmail de origen, si aplica. */
    externalMessageId: text('external_message_id'),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('documents_id_owner_unique').on(t.id, t.ownerId),
    index('documents_owner_idx').on(t.ownerId),
    index('documents_case_idx').on(t.caseId),
    index('documents_owner_sha256_idx').on(t.ownerId, t.sha256),
    index('documents_external_message_idx').on(t.externalMessageId),
    foreignKey({
      name: 'documents_case_owner_fk',
      columns: [t.caseId, t.ownerId],
      foreignColumns: [cases.id, cases.ownerId],
    }).onDelete('restrict'),
    check('documents_sha256_format', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'documents_mime_type_format',
      sql`${t.mimeType} ~ '^[a-z]+/[a-z0-9.+-]+$'`,
    ),
  ],
);
