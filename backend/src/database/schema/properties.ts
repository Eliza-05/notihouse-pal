import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';
import { recordStatus } from './enums.js';
import { profiles } from './profiles.js';

export const properties = pgTable(
  'properties',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    address: text('address'),
    description: text('description'),
    status: recordStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    // Su índice también cubre las búsquedas por owner_id.
    unique('properties_owner_name_unique').on(t.ownerId, t.name),
    // Destino de las FKs compuestas que garantizan el mismo propietario.
    unique('properties_id_owner_unique').on(t.id, t.ownerId),
  ],
);
