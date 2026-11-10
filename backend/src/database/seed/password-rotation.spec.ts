import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createMigratedDatabase,
  type TestDatabase,
} from '../../../test/support/pglite.js';
import { verifyPassword } from '../../auth/password.js';
import { sessionVersion } from '../../auth/session-version.js';
import { validateOutputPath } from '../scripts/rotate-demo-passwords.js';
import * as schema from '../schema/index.js';
import { DEMO_EMAILS } from './demo-data.js';
import { applyDemoSeed } from './demo-seed.js';
import {
  applyDemoPasswordRotation,
  generatePassword,
  planDemoPasswordRotation,
} from './password-rotation.js';

/** Rotación de contraseñas demo sobre PGlite (nunca sobre Neon). */
describe('demo password rotation', () => {
  let t: TestDatabase;
  const shared = randomBytes(12).toString('base64url');

  const accounts = () =>
    t.db
      .select({
        email: schema.authAccounts.email,
        profileId: schema.authAccounts.profileId,
        passwordHash: schema.authAccounts.passwordHash,
        passwordChangedAt: schema.authAccounts.passwordChangedAt,
      })
      .from(schema.authAccounts)
      .orderBy(schema.authAccounts.email);

  beforeAll(async () => {
    t = await createMigratedDatabase();
    await applyDemoSeed(
      t.db,
      DEMO_EMAILS.map((email) => ({ email, password: shared })),
    );
  }, 60_000);

  it('plans distinct, strong passwords for the four accounts', () => {
    const plan = planDemoPasswordRotation();
    expect(plan.map((p) => p.email)).toEqual(DEMO_EMAILS);
    expect(new Set(plan.map((p) => p.password)).size).toBe(4);
    expect(plan.every((p) => /^[A-Za-z0-9_-]{24}$/.test(p.password))).toBe(
      true,
    );
    expect(() =>
      planDemoPasswordRotation(() => 'same-password-123456'),
    ).toThrow(/distintas/);
  });

  it('rotates all accounts atomically and invalidates previous sessions', async () => {
    const before = await accounts();
    const plan = planDemoPasswordRotation();
    const rotated = await applyDemoPasswordRotation(t.db, plan);
    expect(rotated).toHaveLength(4);

    const after = await accounts();
    for (const account of after) {
      const old = before.find((b) => b.email === account.email)!;
      const password = plan.find((p) => p.email === account.email)!.password;
      expect(await verifyPassword(account.passwordHash, password)).toBe(true);
      expect(await verifyPassword(account.passwordHash, shared)).toBe(false);
      expect(account.passwordChangedAt.getTime()).toBeGreaterThan(
        old.passwordChangedAt.getTime(),
      );
      // La versión de sesión cambia: los JWT anteriores dejan de valer.
      expect(
        sessionVersion(account.profileId, account.passwordChangedAt),
      ).not.toBe(sessionVersion(old.profileId, old.passwordChangedAt));
    }
    const events = await t.db
      .select({ metadata: schema.auditEvents.metadata })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'auth_account.password_rotate'));
    expect(events).toHaveLength(4);
    const raw = JSON.stringify(events);
    for (const p of plan) expect(raw).not.toContain(p.password);
    expect(raw).not.toContain('argon2');
  });

  it('changes nothing if any account is missing or hashing fails midway', async () => {
    const before = await accounts();
    const plan = planDemoPasswordRotation();
    await expect(
      applyDemoPasswordRotation(t.db, [
        ...plan.slice(0, 3),
        { email: 'nobody@notihouse.com', password: generatePassword() },
      ]),
    ).rejects.toThrow(/no se cambió ninguna/);
    expect(await accounts()).toEqual(before);
  });

  describe('output file safety', () => {
    const repo = join(tmpdir(), 'repo-root');

    it.each([
      [undefined, /ruta absoluta/],
      ['relative/creds.txt', /ruta absoluta/],
      [join(repo, 'backend', '.local', 'x.txt'), /dentro del repositorio/],
      ['C:\\Users\\x\\OneDrive\\Documentos\\creds.txt', /sincronizada/],
      ['/home/x/Dropbox/creds.txt', /sincronizada/],
    ])('rejects %s', (path, message) => {
      expect(() => validateOutputPath(path, repo)).toThrow(message);
    });

    it('accepts a new absolute path outside the repository', () => {
      const path = join(
        tmpdir(),
        `rotation-${randomBytes(4).toString('hex')}.txt`,
      );
      expect(validateOutputPath(path, repo)).toBe(path);
    });
  });
});
