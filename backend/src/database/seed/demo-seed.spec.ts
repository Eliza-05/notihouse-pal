import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  createMigratedDatabase,
  type TestDatabase,
} from '../../../test/support/pglite.js';
import * as schema from '../schema/index.js';
import { DEMO_EMAILS, DEMO_USERS, LEGACY_DEMO_EMAILS } from './demo-data.js';
import {
  applyDemoSeed,
  countDemoRows,
  inspectDemoSeedState,
  SeedPreconditionError,
  updateLegacyDemoIdentities,
} from './demo-seed.js';
import { verifyPassword } from '../../auth/password.js';

/** Contraseñas generadas en la prueba; nunca se reutilizan fuera de ella. */
const credentialsFor = (emails: string[]) =>
  emails.map((email) => ({
    email,
    password: randomBytes(18).toString('base64url'),
  }));

const EXPECTED_ROWS = {
  profiles: 4,
  auth_accounts: 4,
  properties: 4,
  obligations: 5,
  obligation_occurrences: 6,
  rentals: 2,
  rent_charges: 2,
  contracts: 1,
  cases: 0,
  documents: 0,
  case_proposals: 0,
  hitl_requests: 0,
  audit_events: 4,
};

describe('demo seed (PGlite)', () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createMigratedDatabase();
  }, 60_000);

  afterEach(async () => {
    await t.client.close();
  });

  it('plans the four demo users on an empty database', async () => {
    const state = await inspectDemoSeedState(t.db);
    expect(state).toEqual({ existing: [], missing: DEMO_EMAILS });
    expect(DEMO_EMAILS).toHaveLength(4);
  });

  it('creates accounts and fictitious data in legitimate initial states', async () => {
    const credentials = credentialsFor(DEMO_EMAILS);
    await applyDemoSeed(t.db, credentials);

    expect(await countDemoRows(t.db)).toEqual(EXPECTED_ROWS);

    const confirmed = await t.client.query<{ n: number }>(`
      SELECT (SELECT count(*) FROM obligation_occurrences WHERE status <> 'pending')
           + (SELECT count(*) FROM rent_charges WHERE status <> 'expected')
           + (SELECT count(*) FROM obligation_occurrences WHERE confirmed_at IS NOT NULL)
           + (SELECT count(*) FROM rent_charges WHERE confirmed_at IS NOT NULL) AS n`);
    expect(Number(confirmed.rows[0]!.n)).toBe(0);
  });

  it('stores only Argon2id hashes, never the generated passwords', async () => {
    const credentials = credentialsFor(DEMO_EMAILS);
    await applyDemoSeed(t.db, credentials);

    const accounts = await t.db.select().from(schema.authAccounts);
    expect(new Set(accounts.map((a) => a.passwordHash)).size).toBe(4);
    for (const account of accounts) {
      expect(account.passwordHash).toMatch(/^\$argon2id\$/);
    }
    const dump = JSON.stringify(
      await t.client.query('SELECT * FROM auth_accounts'),
    );
    for (const { password } of credentials) {
      expect(dump).not.toContain(password);
    }
  });

  it('assigns every demo record to its own owner', async () => {
    await applyDemoSeed(t.db, credentialsFor(DEMO_EMAILS));
    const rows = await t.client.query<{
      email: string;
      properties: string;
      foreign_rows: string;
    }>(`
      SELECT a.email,
             (SELECT string_agg(p.name, ',') FROM properties p WHERE p.owner_id = a.profile_id) AS properties,
             (SELECT count(*) FROM obligation_occurrences o
                JOIN obligations ob ON ob.id = o.obligation_id
               WHERE ob.owner_id = a.profile_id AND o.owner_id <> a.profile_id) AS foreign_rows
        FROM auth_accounts a ORDER BY a.email`);
    expect(rows.rows.map((r) => [r.email, r.properties])).toEqual([
      ['andres.gomez@notihouse.com', 'Apartaestudio Demo Arriendos'],
      ['camila.torres@notihouse.com', 'Local comercial Demo Contratos'],
      ['daniel.rojas@notihouse.com', 'Casa Demo Integración'],
      ['laura.martinez@notihouse.com', 'Apartamento Demo Hogar'],
    ]);
    expect(rows.rows.every((r) => Number(r.foreign_rows) === 0)).toBe(true);
  });

  it('is idempotent: a second run finds nothing to create', async () => {
    await applyDemoSeed(t.db, credentialsFor(DEMO_EMAILS));
    const state = await inspectDemoSeedState(t.db);
    expect(state).toEqual({ existing: DEMO_EMAILS, missing: [] });
  });

  it('never replaces existing credentials (the whole transaction aborts)', async () => {
    await applyDemoSeed(t.db, credentialsFor(DEMO_EMAILS));
    const before = await t.db.select().from(schema.authAccounts);

    await expect(
      applyDemoSeed(t.db, credentialsFor([DEMO_EMAILS[0]!])),
    ).rejects.toThrow();

    expect(await t.db.select().from(schema.authAccounts)).toEqual(before);
    expect(await countDemoRows(t.db)).toEqual(EXPECTED_ROWS);
  });

  it('creates only the missing users when some already exist', async () => {
    await applyDemoSeed(t.db, credentialsFor(DEMO_EMAILS.slice(0, 2)));
    const state = await inspectDemoSeedState(t.db);
    expect(state.missing).toEqual(DEMO_EMAILS.slice(2));
    await applyDemoSeed(t.db, credentialsFor(state.missing));
    expect(await countDemoRows(t.db)).toEqual(EXPECTED_ROWS);
  });

  it.each([
    [
      'a non-demo account',
      `INSERT INTO profiles (id, display_name) VALUES ('11111111-1111-4111-8111-111111111111', 'Real');
      INSERT INTO auth_accounts (profile_id, email, password_hash) VALUES ('11111111-1111-4111-8111-111111111111', 'real@example.com', '$argon2id$x')`,
    ],
    [
      'a profile without account',
      `INSERT INTO profiles (display_name) VALUES ('Sin cuenta')`,
    ],
    [
      'a provider in the global catalog',
      `INSERT INTO providers (name, slug) VALUES ('Proveedor', 'proveedor')`,
    ],
    [
      'a system audit event',
      `INSERT INTO audit_events (actor_type, component, action, result) VALUES ('system', 'x', 'y', 'success')`,
    ],
  ])('refuses to run when it finds %s', async (_case, statements) => {
    await t.client.exec(statements);
    await expect(inspectDemoSeedState(t.db)).rejects.toBeInstanceOf(
      SeedPreconditionError,
    );
  });

  it('rejects business rows owned by someone else', async () => {
    await applyDemoSeed(t.db, credentialsFor(DEMO_EMAILS.slice(0, 1)));
    // Perfil ajeno con un inmueble: aunque luego tenga cuenta demo, sus datos no lo son.
    await t.client.exec(`
      INSERT INTO profiles (id, display_name) VALUES ('22222222-2222-4222-8222-222222222222', 'Ajeno');
      INSERT INTO properties (owner_id, name) VALUES ('22222222-2222-4222-8222-222222222222', 'Inmueble ajeno');`);
    await expect(inspectDemoSeedState(t.db)).rejects.toThrow(/perfiles/);
  });
});

describe('demo identities update (PGlite)', () => {
  let t: TestDatabase;

  /** Recrea el estado de las versiones anteriores del seed (correos @notihouse.test). */
  async function seedLegacyState() {
    await applyDemoSeed(t.db, credentialsFor(DEMO_EMAILS));
    for (const user of DEMO_USERS) {
      await t.db
        .update(schema.authAccounts)
        .set({ email: user.legacyEmail })
        .where(eq(schema.authAccounts.email, user.email));
    }
    // Fecha anterior para comprobar que la actualización la renueva.
    await t.client.exec(
      `UPDATE auth_accounts SET password_changed_at = now() - interval '1 day'`,
    );
  }

  const snapshot = async () => ({
    accounts: (
      await t.client.query<{ id: string; profile_id: string }>(
        'SELECT id, profile_id FROM auth_accounts ORDER BY id',
      )
    ).rows,
    business: (
      await t.client.query<{ t: string; h: string }>(`
        SELECT 'p' AS t, md5(string_agg(x::text, '|' ORDER BY x.id)) AS h FROM properties x
        UNION ALL SELECT 'o', md5(string_agg(x::text, '|' ORDER BY x.id)) FROM obligations x
        UNION ALL SELECT 'oo', md5(string_agg(x::text, '|' ORDER BY x.id)) FROM obligation_occurrences x
        UNION ALL SELECT 'r', md5(string_agg(x::text, '|' ORDER BY x.id)) FROM rentals x
        UNION ALL SELECT 'rc', md5(string_agg(x::text, '|' ORDER BY x.id)) FROM rent_charges x
        UNION ALL SELECT 'c', md5(string_agg(x::text, '|' ORDER BY x.id)) FROM contracts x
        UNION ALL SELECT 'a', md5(string_agg(x::text, '|' ORDER BY x.id)) FROM audit_events x`)
    ).rows,
  });

  beforeEach(async () => {
    t = await createMigratedDatabase();
    await seedLegacyState();
  }, 60_000);

  afterEach(async () => {
    await t.client.close();
  });

  it('makes the seed refuse to run until the legacy accounts are updated', async () => {
    await expect(inspectDemoSeedState(t.db)).rejects.toThrow(
      /correos anteriores.*db:demo:update-identities/,
    );
  });

  it('renames accounts in place, keeping UUIDs and all business data', async () => {
    const before = await snapshot();
    const legacyOwners = await t.client.query<{
      email: string;
      profile_id: string;
    }>('SELECT email, profile_id FROM auth_accounts');
    const ownerOf = new Map(
      legacyOwners.rows.map((r) => [r.email, r.profile_id]),
    );

    const updated = await updateLegacyDemoIdentities(
      t.db,
      'temporary-demo-pass',
    );

    const after = await snapshot();
    expect(after.accounts).toEqual(before.accounts);
    // Los datos de negocio no cambian (la auditoría crece con 4 eventos nuevos).
    expect(after.business.filter((r) => r.t !== 'a')).toEqual(
      before.business.filter((r) => r.t !== 'a'),
    );
    for (const user of DEMO_USERS) {
      const row = updated.find((u) => u.email === user.email)!;
      expect(row.previousEmail).toBe(user.legacyEmail);
      expect(row.profileId).toBe(ownerOf.get(user.legacyEmail));
    }

    const identities = await t.client.query<{
      email: string;
      display_name: string;
    }>(
      'SELECT a.email, p.display_name FROM auth_accounts a JOIN profiles p ON p.id = a.profile_id ORDER BY a.email',
    );
    expect(identities.rows).toEqual([
      { email: 'andres.gomez@notihouse.com', display_name: 'Andrés Gómez' },
      { email: 'camila.torres@notihouse.com', display_name: 'Camila Torres' },
      { email: 'daniel.rojas@notihouse.com', display_name: 'Daniel Rojas' },
      { email: 'laura.martinez@notihouse.com', display_name: 'Laura Martínez' },
    ]);
  });

  it('stores an independent Argon2id hash per account and renews password_changed_at', async () => {
    const password = randomBytes(12).toString('base64url');
    await updateLegacyDemoIdentities(t.db, password);

    const accounts = await t.db.select().from(schema.authAccounts);
    expect(new Set(accounts.map((a) => a.passwordHash)).size).toBe(4);
    for (const account of accounts) {
      expect(account.passwordHash).toMatch(/^\$argon2id\$/);
      expect(account.passwordHash).not.toContain(password);
      expect(account.isActive).toBe(true);
      expect(Date.now() - account.passwordChangedAt.getTime()).toBeLessThan(
        60_000,
      );
      await expect(
        verifyPassword(account.passwordHash, password),
      ).resolves.toBe(true);
    }
  });

  it('audits each change without passwords or hashes', async () => {
    const password = randomBytes(12).toString('base64url');
    await updateLegacyDemoIdentities(t.db, password);

    const events = await t.client.query<{ metadata: object }>(
      `SELECT metadata FROM audit_events WHERE action = 'auth_account.identity_update'`,
    );
    expect(events.rows).toHaveLength(4);
    const raw = JSON.stringify(events.rows);
    expect(raw).not.toContain(password);
    expect(raw).not.toContain('argon2');
    expect(
      (
        await t.client.query(
          `SELECT 1 FROM audit_events WHERE action = 'auth_account.create'`,
        )
      ).rows,
    ).toHaveLength(4);
  });

  it('leaves the seed idempotent afterwards', async () => {
    await updateLegacyDemoIdentities(t.db, 'temporary-demo-pass');
    expect(await inspectDemoSeedState(t.db)).toEqual({
      existing: expect.arrayContaining(DEMO_EMAILS),
      missing: [],
    });
    expect(await countDemoRows(t.db)).toEqual(EXPECTED_ROWS_AFTER_UPDATE);
  });

  it.each([
    [
      'it already ran',
      async () => {
        await updateLegacyDemoIdentities(t.db, 'temporary-demo-pass');
      },
    ],
    [
      'an unexpected account exists',
      async () => {
        await t.client.exec(`
        INSERT INTO profiles (id, display_name) VALUES ('44444444-4444-4444-8444-444444444444', 'Otro');
        INSERT INTO auth_accounts (profile_id, email, password_hash) VALUES ('44444444-4444-4444-8444-444444444444', 'otro@notihouse.com', '$argon2id$x')`);
      },
    ],
    [
      'a legacy account is missing',
      async () => {
        await t.client.exec(
          `UPDATE auth_accounts SET email = 'renombrada@notihouse.com' WHERE email = '${LEGACY_DEMO_EMAILS[0]}'`,
        );
      },
    ],
  ])('aborts without writing when %s', async (_case, arrange) => {
    await arrange();
    const before = await t.client.query(
      'SELECT * FROM auth_accounts ORDER BY id',
    );
    const auditBefore = await t.client.query(
      'SELECT count(*)::int AS n FROM audit_events',
    );

    await expect(
      updateLegacyDemoIdentities(t.db, 'temporary-demo-pass'),
    ).rejects.toBeInstanceOf(SeedPreconditionError);

    expect(
      (await t.client.query('SELECT * FROM auth_accounts ORDER BY id')).rows,
    ).toEqual(before.rows);
    expect(
      (await t.client.query('SELECT count(*)::int AS n FROM audit_events'))
        .rows,
    ).toEqual(auditBefore.rows);
  });
});

const EXPECTED_ROWS_AFTER_UPDATE = {
  profiles: 4,
  auth_accounts: 4,
  properties: 4,
  obligations: 5,
  obligation_occurrences: 6,
  rentals: 2,
  rent_charges: 2,
  contracts: 1,
  cases: 0,
  documents: 0,
  case_proposals: 0,
  hitl_requests: 0,
  audit_events: 8,
};

describe('auth_accounts constraints (PGlite)', () => {
  let t: TestDatabase;
  let profileId: string;
  const validHash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';

  beforeAll(async () => {
    t = await createMigratedDatabase();
    const [p] = await t.db
      .insert(schema.profiles)
      .values({ displayName: 'Prueba' })
      .returning();
    profileId = p!.id;
  }, 60_000);

  afterAll(async () => {
    await t.client.close();
  });

  beforeEach(async () => {
    await t.client.exec('BEGIN');
  });

  afterEach(async () => {
    await t.client.exec('ROLLBACK');
  });

  const insert = (values: Partial<typeof schema.authAccounts.$inferInsert>) =>
    t.db.insert(schema.authAccounts).values({
      profileId,
      email: 'user@notihouse.test',
      passwordHash: validHash,
      ...values,
    });

  const expectViolation = async (
    promise: Promise<unknown>,
    constraint: string,
  ) => {
    await t.client.exec('SAVEPOINT s');
    let message = '';
    try {
      await promise;
    } catch (error) {
      const e = error as Error & { cause?: Error };
      message = `${e.message} ${e.cause?.message ?? ''}`;
    }
    await t.client.exec('ROLLBACK TO SAVEPOINT s');
    expect(message).toContain(constraint);
  };

  it('rejects plaintext or non-Argon2id password hashes', async () => {
    await expectViolation(
      insert({ passwordHash: 'MiContraseña123' }),
      'auth_accounts_password_hash_argon2id',
    );
    await expectViolation(
      insert({ passwordHash: '$2b$10$bcrypthash' }),
      'auth_accounts_password_hash_argon2id',
    );
  });

  it('only accepts normalized emails, so case variants cannot duplicate', async () => {
    await expectViolation(
      insert({ email: 'User@NotiHouse.test' }),
      'auth_accounts_email_normalized',
    );
    await expectViolation(
      insert({ email: ' user@notihouse.test' }),
      // Con espacios, PostgreSQL evalúa primero el check de formato (orden alfabético).
      'auth_accounts_email_format',
    );
    await expectViolation(
      insert({ email: 'not-an-email' }),
      'auth_accounts_email_format',
    );
  });

  it('enforces a unique email and one account per profile', async () => {
    await insert({});
    const [other] = await t.db
      .insert(schema.profiles)
      .values({ displayName: 'Otro' })
      .returning();
    await expectViolation(
      insert({ profileId: other!.id }),
      'auth_accounts_email_unique',
    );
    await expectViolation(
      insert({ email: 'second@notihouse.test' }),
      'auth_accounts_profile_id_unique',
    );
  });

  it('requires an existing profile and protects it from deletion', async () => {
    await expectViolation(
      insert({ profileId: '33333333-3333-4333-8333-333333333333' }),
      'auth_accounts_profile_id_profiles_id_fk',
    );
    await insert({});
    await expectViolation(
      t.db.delete(schema.profiles).where(eq(schema.profiles.id, profileId)),
      'auth_accounts_profile_id_profiles_id_fk',
    );
  });

  it('defaults new accounts to active with a password change timestamp', async () => {
    const [row] = await insert({}).returning();
    expect(row!.isActive).toBe(true);
    expect(row!.passwordChangedAt).toBeInstanceOf(Date);
    const [{ now }] = (
      await t.db.execute<{ now: Date }>(sql`SELECT now() AS now`)
    ).rows as [{ now: Date }];
    expect(
      Math.abs(row!.passwordChangedAt.getTime() - new Date(now).getTime()),
    ).toBeLessThan(5_000);
  });
});
