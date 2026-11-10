import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, tstz } from './columns.js';
import { profiles } from './profiles.js';

/**
 * Credenciales locales (correo + contraseña) de un perfil.
 * No hay registro público: las cuentas las crea el equipo (seed de demostración).
 * Las cuentas no se borran; se desactivan con `is_active = false`.
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: id(),
    profileId: uuid('profile_id')
      .notNull()
      .unique()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    /** Correo normalizado (minúsculas, sin espacios); único. */
    email: text('email').notNull().unique(),
    /** Hash Argon2id en formato PHC. Nunca se expone en respuestas. */
    passwordHash: text('password_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Los tokens emitidos antes de esta fecha dejan de ser válidos. */
    passwordChangedAt: tstz('password_changed_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    // Evita duplicados por mayúsculas o espacios: solo se admite la forma normalizada.
    check(
      'auth_accounts_email_normalized',
      sql`${t.email} = lower(btrim(${t.email}))`,
    ),
    check(
      'auth_accounts_email_format',
      sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`,
    ),
    // Garantiza en la base de datos que nunca se guarda una contraseña en claro.
    check(
      'auth_accounts_password_hash_argon2id',
      sql`${t.passwordHash} LIKE '$argon2id$%'`,
    ),
  ],
);
