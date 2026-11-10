import { inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../auth/password.js';
import * as schema from '../schema/index.js';
import { DEMO_EMAILS } from './demo-data.js';
import { type SeedDatabase, SeedPreconditionError } from './demo-seed.js';

/** 18 bytes aleatorios → 24 caracteres base64url (~144 bits). */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

export interface PlannedRotation {
  email: string;
  /** Contraseña nueva: solo existe en memoria y en el archivo de salida protegido. */
  password: string;
}

/**
 * Contraseñas nuevas, individuales y distintas, para las cuatro cuentas demo.
 * Se generan ANTES de tocar la base para poder guardarlas de forma segura
 * primero: así una falla después del commit nunca deja cuentas sin acceso.
 */
export function planDemoPasswordRotation(
  generator: () => string = generatePassword,
): PlannedRotation[] {
  const planned = DEMO_EMAILS.map((email) => ({
    email,
    password: generator(),
  }));
  const unique = new Set(planned.map((p) => p.password));
  if (
    unique.size !== planned.length ||
    planned.some((p) => p.password.length < 16)
  ) {
    throw new SeedPreconditionError(
      'Las contraseñas generadas deben ser distintas y de al menos 16 caracteres',
    );
  }
  return planned;
}

export interface RotatedAccount {
  email: string;
  profileId: string;
  passwordChangedAt: Date;
}

/**
 * Aplica la rotación en UNA transacción: o cambian las cuatro cuentas o
 * ninguna. Cada cuenta recibe un hash Argon2id propio y un
 * `password_changed_at` nuevo, lo que invalida todos sus JWT anteriores
 * (claim `sv`). Se registra un evento de auditoría por cuenta, sin
 * contraseñas ni hashes. No toca perfiles ni datos de negocio.
 */
export async function applyDemoPasswordRotation(
  db: SeedDatabase,
  planned: readonly PlannedRotation[],
): Promise<RotatedAccount[]> {
  const hashes = new Map(
    await Promise.all(
      planned.map(
        async (p) => [p.email, await hashPassword(p.password)] as const,
      ),
    ),
  );
  return db.transaction(async (tx) => {
    const accounts = await tx
      .select({
        id: schema.authAccounts.id,
        email: schema.authAccounts.email,
        profileId: schema.authAccounts.profileId,
      })
      .from(schema.authAccounts)
      .where(
        inArray(
          schema.authAccounts.email,
          planned.map((p) => p.email),
        ),
      )
      .orderBy(schema.authAccounts.email)
      .for('update');
    if (accounts.length !== planned.length) {
      throw new SeedPreconditionError(
        `Se esperaban ${planned.length} cuentas demo y existen ${accounts.length}; no se cambió ninguna`,
      );
    }

    const rotated: RotatedAccount[] = [];
    for (const account of accounts) {
      const [row] = await tx
        .update(schema.authAccounts)
        .set({
          passwordHash: hashes.get(account.email)!,
          passwordChangedAt: sql`clock_timestamp()`,
        })
        .where(inArray(schema.authAccounts.id, [account.id]))
        .returning({
          passwordChangedAt: schema.authAccounts.passwordChangedAt,
        });
      await tx.insert(schema.auditEvents).values({
        ownerId: account.profileId,
        actorType: 'system',
        actorId: 'demo-password-rotation',
        component: 'backend.admin',
        action: 'auth_account.password_rotate',
        result: 'success',
        // Sin contraseñas ni hashes.
        metadata: {
          resource: 'auth_account',
          resourceId: account.id,
          email: account.email,
          demo: true,
          invalidatesPreviousTokens: true,
        },
      });
      rotated.push({
        email: account.email,
        profileId: account.profileId,
        passwordChangedAt: row!.passwordChangedAt,
      });
    }
    return rotated;
  });
}
