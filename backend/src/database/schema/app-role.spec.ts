import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Rol de aplicación restringido (database/admin/*.sql) sobre PGlite con las
 * migraciones versionadas. No se conecta a Neon: valida el SQL preparado
 * antes de ejecutarlo allí (Fase 4.2F.2/4.2F.3).
 */
const DATABASE_DIR = fileURLToPath(
  new URL('../../../../database/', import.meta.url),
);
const adminSql = (name: string) =>
  readFileSync(`${DATABASE_DIR}admin/${name}`, 'utf8');

describe('restricted application role (PGlite)', () => {
  let pg: PGlite;
  let ownerId: string;

  const asApp = async (statement: string, params: unknown[] = []) => {
    await pg.exec('SET ROLE notihouse_app');
    try {
      return (await pg.query<Record<string, unknown>>(statement, params)).rows;
    } finally {
      await pg.exec('RESET ROLE');
    }
  };

  const deniedAsApp = async (statement: string, params: unknown[] = []) => {
    let message = '';
    try {
      await asApp(statement, params);
    } catch (error) {
      message = (error as Error).message;
    }
    return message;
  };

  beforeAll(async () => {
    pg = new PGlite();
    await migrate(drizzle({ client: pg }), {
      migrationsFolder: `${DATABASE_DIR}migrations`,
    });
    await pg.exec(adminSql('01-create-app-role.sql'));
    await pg.exec(adminSql('02-grant-app-privileges.sql'));
    // Repetir es seguro (idempotente).
    await pg.exec(adminSql('01-create-app-role.sql'));
    await pg.exec(adminSql('02-grant-app-privileges.sql'));
    ownerId = (
      await pg.query<{ id: string }>(
        `INSERT INTO profiles (display_name) VALUES ('owner') RETURNING id`,
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  it('matches the expected privilege matrix exactly', async () => {
    const rows = (
      await pg.query<{ table_name: string; ok: boolean }>(
        adminSql('03-verify-app-privileges.sql'),
      )
    ).rows;
    expect(rows).toHaveLength(18);
    expect(rows.filter((r) => !r.ok).map((r) => r.table_name)).toEqual([]);
  });

  it('creates a role without login, superuser or role management', async () => {
    const [role] = (
      await pg.query(
        `SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = 'notihouse_app'`,
      )
    ).rows;
    expect(role).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
    });
  });

  it('allows the operations the API performs', async () => {
    const [property] = await asApp(
      `INSERT INTO properties (owner_id, name) VALUES ($1, 'Casa') RETURNING id`,
      [ownerId],
    );
    await asApp(`UPDATE properties SET description = 'x' WHERE id = $1`, [
      property!.id,
    ]);
    await asApp(`SELECT id FROM properties WHERE id = $1 FOR UPDATE`, [
      property!.id,
    ]);
    await asApp(
      `INSERT INTO audit_events (owner_id, actor_type, component, action, result) VALUES ($1, 'user', 'test', 'property.create', 'success')`,
      [ownerId],
    );
    await asApp(`SELECT count(*) FROM auth_accounts`);
    await asApp(`SELECT id FROM documents FOR SHARE`);
  });

  it.each([
    ['delete business data', `DELETE FROM properties`, 'permission denied'],
    ['truncate', `TRUNCATE obligations`, 'permission denied'],
    [
      'rewrite audit',
      `UPDATE audit_events SET action = 'x'`,
      'permission denied',
    ],
    ['delete audit', `DELETE FROM audit_events`, 'permission denied'],
    [
      'change a password hash',
      `UPDATE auth_accounts SET password_hash = 'x'`,
      'permission denied',
    ],
    [
      'create a profile',
      `INSERT INTO profiles (display_name) VALUES ('x')`,
      'permission denied',
    ],
    [
      'change a storage key',
      `UPDATE documents SET storage_key = 'x'`,
      'permission denied',
    ],
    [
      'rewrite an application',
      `UPDATE proposal_applications SET applied_by = applied_by`,
      'permission denied',
    ],
    ['create tables', `CREATE TABLE evil (id int)`, 'permission denied'],
    ['alter tables', `ALTER TABLE cases ADD COLUMN x int`, 'must be owner'],
    ['drop tables', `DROP TABLE alerts`, 'must be owner'],
    [
      'disable the audit trigger',
      `ALTER TABLE audit_events DISABLE TRIGGER ALL`,
      'must be owner',
    ],
    [
      'read the migration history',
      `SELECT * FROM drizzle.__drizzle_migrations`,
      'permission denied',
    ],
    ['create roles', `CREATE ROLE intruder`, 'permission denied'],
  ])('denies: %s', async (_label, statement, expected) => {
    expect(await deniedAsApp(statement)).toContain(expected);
  });

  it('cannot grant itself new privileges (GRANT without grant option is a no-op)', async () => {
    await asApp(`GRANT DELETE ON properties TO notihouse_app`);
    const [row] = (
      await pg.query<{ can: boolean }>(
        `SELECT has_table_privilege('notihouse_app', 'public.properties', 'DELETE') AS can`,
      )
    ).rows;
    expect(row!.can).toBe(false);
  });
});
