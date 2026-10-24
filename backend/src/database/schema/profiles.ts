import { pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';

/** Propietario de la información. La autenticación se implementará en una fase posterior. */
export const profiles = pgTable('profiles', {
  id: id(),
  /** Identificador del proveedor de identidad futuro (p. ej. `sub` de OAuth). */
  externalAuthId: text('external_auth_id').unique(),
  displayName: text('display_name'),
  ...timestamps(),
});
