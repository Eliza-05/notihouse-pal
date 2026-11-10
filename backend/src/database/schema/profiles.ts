import { pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';

/**
 * Propietario de la información. Sus credenciales locales están en `auth_accounts`.
 * El `id` del perfil es el `sub` de los JWT.
 */
export const profiles = pgTable('profiles', {
  id: id(),
  /**
   * Reservado para un proveedor de identidad externo (p. ej. `sub` de OAuth).
   * No se usa: la autenticación actual es local (`auth_accounts`).
   */
  externalAuthId: text('external_auth_id').unique(),
  displayName: text('display_name'),
  ...timestamps(),
});
