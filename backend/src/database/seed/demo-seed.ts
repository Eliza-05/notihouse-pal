import {
  and,
  count,
  eq,
  getTableName,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { hashPassword } from '../../auth/password.js';
import * as schema from '../schema/index.js';
import { DEMO_EMAILS, DEMO_USERS, LEGACY_DEMO_EMAILS } from './demo-data.js';

/** Base de datos Drizzle con el esquema del proyecto (node-postgres o PGlite). */
export type SeedDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
export type SeedTransaction = Parameters<
  Parameters<SeedDatabase['transaction']>[0]
>[0];

export class SeedPreconditionError extends Error {}

export interface DemoSeedState {
  existing: string[];
  missing: string[];
}

/** Tablas con `owner_id`: solo pueden contener filas de perfiles de demostración. */
const OWNER_SCOPED_TABLES = [
  schema.properties,
  schema.obligations,
  schema.obligationOccurrences,
  schema.rentals,
  schema.rentCharges,
  schema.contracts,
  schema.cases,
  schema.documents,
  schema.caseProposals,
  schema.hitlRequests,
] as const;

/**
 * Comprueba, sin escribir, que la base solo contiene datos administrados por
 * este seed. Lanza `SeedPreconditionError` ante cualquier dato inesperado.
 */
export async function inspectDemoSeedState(
  db: SeedDatabase,
): Promise<DemoSeedState> {
  const accounts = await db
    .select({
      profileId: schema.authAccounts.profileId,
      email: schema.authAccounts.email,
    })
    .from(schema.authAccounts);

  const legacy = accounts.filter((a) => LEGACY_DEMO_EMAILS.includes(a.email));
  if (legacy.length > 0) {
    // Nunca se recrean ni se migran en silencio: requiere el procedimiento explícito.
    throw new SeedPreconditionError(
      `Existen ${legacy.length} cuentas demo con correos anteriores. Ejecuta npm run db:demo:update-identities`,
    );
  }

  const foreign = accounts.filter((a) => !DEMO_EMAILS.includes(a.email));
  if (foreign.length > 0) {
    throw new SeedPreconditionError(
      `Existen ${foreign.length} cuentas que no son de demostración`,
    );
  }
  const demoProfileIds = accounts.map((a) => a.profileId);

  const [orphanProfiles] = await db
    .select({ n: count() })
    .from(schema.profiles)
    .where(notInArray(schema.profiles.id, demoProfileIds));
  if (orphanProfiles!.n > 0) {
    throw new SeedPreconditionError(
      `Existen ${orphanProfiles!.n} perfiles sin cuenta de demostración`,
    );
  }

  for (const table of OWNER_SCOPED_TABLES) {
    const [row] = await db
      .select({ n: count() })
      .from(table)
      .where(notInArray(table.ownerId, demoProfileIds));
    if (row!.n > 0) {
      throw new SeedPreconditionError(
        `La tabla ${getTableName(table)} tiene ${row!.n} filas de otros propietarios`,
      );
    }
  }

  const [foreignAudit] = await db
    .select({ n: count() })
    .from(schema.auditEvents)
    .where(
      or(
        isNull(schema.auditEvents.ownerId),
        notInArray(schema.auditEvents.ownerId, demoProfileIds),
      ),
    );
  if (foreignAudit!.n > 0) {
    throw new SeedPreconditionError(
      `audit_events tiene ${foreignAudit!.n} eventos ajenos a la demostración`,
    );
  }

  // Catálogo global: el seed no lo administra, así que debe estar vacío.
  for (const table of [schema.providers, schema.providerPaymentLinks]) {
    const [row] = await db.select({ n: count() }).from(table);
    if (row!.n > 0) {
      throw new SeedPreconditionError(
        `La tabla ${getTableName(table)} no está vacía`,
      );
    }
  }

  const existing = accounts.map((a) => a.email);
  return {
    existing,
    missing: DEMO_EMAILS.filter((email) => !existing.includes(email)),
  };
}

export interface DemoCredential {
  email: string;
  password: string;
}

/**
 * Crea, en una única transacción, los perfiles, cuentas y datos ficticios de
 * los usuarios indicados. Si alguno ya existe, la restricción UNIQUE del correo
 * aborta la transacción completa: nunca se reemplazan credenciales.
 */
export async function applyDemoSeed(
  db: SeedDatabase,
  credentials: readonly DemoCredential[],
): Promise<void> {
  const prepared = await Promise.all(
    credentials.map(async (c) => {
      const user = DEMO_USERS.find((u) => u.email === c.email);
      if (!user) {
        throw new SeedPreconditionError(`${c.email} no es un usuario demo`);
      }
      return { user, passwordHash: await hashPassword(c.password) };
    }),
  );

  await db.transaction(async (tx) => {
    for (const { user, passwordHash } of prepared) {
      const [profile] = await tx
        .insert(schema.profiles)
        .values({ displayName: user.displayName })
        .returning({ id: schema.profiles.id });
      const ownerId = profile!.id;

      await tx
        .insert(schema.authAccounts)
        .values({ profileId: ownerId, email: user.email, passwordHash });
      await user.seedData(tx, ownerId);
      await tx.insert(schema.auditEvents).values({
        ownerId,
        actorType: 'system',
        actorId: 'seed-demo',
        component: 'backend.seed',
        action: 'auth_account.create',
        result: 'success',
        metadata: { email: user.email, demo: true },
      });
    }
  });
}

export interface UpdatedDemoIdentity {
  profileId: string;
  accountId: string;
  previousEmail: string;
  email: string;
  displayName: string;
}

/**
 * Renombra las cuentas demo creadas con los correos anteriores a las
 * identidades oficiales actuales, en una única transacción:
 * conserva los UUID de perfiles y cuentas y todos sus datos de negocio,
 * genera un hash Argon2id independiente por cuenta y actualiza
 * `password_changed_at` (invalida los JWT anteriores).
 *
 * Exige que existan exactamente las cuatro cuentas anteriores y ninguna otra;
 * ante cualquier diferencia aborta sin escribir.
 */
export async function updateLegacyDemoIdentities(
  db: SeedDatabase,
  password: string,
): Promise<UpdatedDemoIdentity[]> {
  // Un hash por cuenta: mismo texto, salt distinto.
  const hashes = await Promise.all(
    DEMO_USERS.map(() => hashPassword(password)),
  );

  return db.transaction(async (tx) => {
    // Bloquea las cuentas para evitar cambios concurrentes durante la actualización.
    const accounts = await tx
      .select({
        id: schema.authAccounts.id,
        profileId: schema.authAccounts.profileId,
        email: schema.authAccounts.email,
      })
      .from(schema.authAccounts)
      .for('update');

    const emails = accounts.map((a) => a.email).sort();
    if (
      emails.length !== LEGACY_DEMO_EMAILS.length ||
      emails.join() !== [...LEGACY_DEMO_EMAILS].sort().join()
    ) {
      throw new SeedPreconditionError(
        'Las cuentas existentes no son exactamente las cuatro cuentas demo anteriores',
      );
    }

    const updated: UpdatedDemoIdentity[] = [];
    for (const [index, user] of DEMO_USERS.entries()) {
      const account = accounts.find((a) => a.email === user.legacyEmail)!;

      await tx
        .update(schema.profiles)
        .set({ displayName: user.displayName })
        .where(eq(schema.profiles.id, account.profileId));

      const rows = await tx
        .update(schema.authAccounts)
        .set({
          email: user.email,
          passwordHash: hashes[index]!,
          isActive: true,
          passwordChangedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.authAccounts.id, account.id),
            eq(schema.authAccounts.email, user.legacyEmail),
          ),
        )
        .returning({ id: schema.authAccounts.id });
      if (rows.length !== 1) {
        throw new SeedPreconditionError(
          `No se pudo actualizar la cuenta ${user.legacyEmail}`,
        );
      }

      await tx.insert(schema.auditEvents).values({
        ownerId: account.profileId,
        actorType: 'system',
        actorId: 'demo-identities-update',
        component: 'backend.seed',
        action: 'auth_account.identity_update',
        result: 'success',
        // Sin contraseñas ni hashes.
        metadata: {
          previousEmail: user.legacyEmail,
          email: user.email,
          changes: ['email', 'display_name', 'password'],
          demo: true,
        },
      });

      updated.push({
        profileId: account.profileId,
        accountId: account.id,
        previousEmail: user.legacyEmail,
        email: user.email,
        displayName: user.displayName,
      });
    }
    return updated;
  });
}

/** Número de filas por tabla que pertenecen a los perfiles de demostración. */
export async function countDemoRows(
  db: SeedDatabase,
): Promise<Record<string, number>> {
  const ids = (
    await db
      .select({ id: schema.authAccounts.profileId })
      .from(schema.authAccounts)
      .where(inArray(schema.authAccounts.email, DEMO_EMAILS))
  ).map((r) => r.id);

  const result: Record<string, number> = {
    profiles: ids.length,
    auth_accounts: ids.length,
  };
  for (const table of [...OWNER_SCOPED_TABLES, schema.auditEvents]) {
    const [row] = await db
      .select({ n: count() })
      .from(table)
      .where(inArray(table.ownerId, ids));
    result[getTableName(table)] = row!.n;
  }
  return result;
}
