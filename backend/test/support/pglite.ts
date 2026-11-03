import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../src/auth/password.js';
import * as schema from '../../src/database/schema/index.js';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../database/migrations', import.meta.url),
);

export interface TestDatabase {
  client: PGlite;
  db: PgliteDatabase<typeof schema>;
}

/** PostgreSQL en memoria con todas las migraciones versionadas aplicadas. */
export async function createMigratedDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { client, db };
}

export interface TestUser {
  profileId: string;
  email: string;
  password: string;
  /** `password_changed_at` al crear la cuenta (versión de sesión de sus JWT). */
  passwordChangedAt: Date;
}

export async function createTestUser(
  db: TestDatabase['db'],
  options: {
    email: string;
    password: string;
    displayName: string;
    isActive?: boolean;
  },
): Promise<TestUser> {
  const [profile] = await db
    .insert(schema.profiles)
    .values({ displayName: options.displayName })
    .returning({ id: schema.profiles.id });
  const [account] = await db
    .insert(schema.authAccounts)
    .values({
      profileId: profile!.id,
      email: options.email,
      passwordHash: await hashPassword(options.password),
      isActive: options.isActive ?? true,
    })
    .returning({ passwordChangedAt: schema.authAccounts.passwordChangedAt });
  return {
    profileId: profile!.id,
    email: options.email,
    password: options.password,
    passwordChangedAt: account!.passwordChangedAt,
  };
}
