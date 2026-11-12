import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  APP_ROLE,
  assertConnectedTarget,
  assertFacts,
  assertSafeConfiguration,
  ENABLE_VALUE,
  OWNER_ROLE,
  type TargetFacts,
  UnsafeTargetError,
} from '../../src/database/scripts/concurrency/target-guard.js';
import { createMigratedDatabase } from '../support/pglite.js';
import {
  appUrl,
  guardState,
  Harness,
  ownerUrl,
  recordEvidence,
  statuses,
} from './support/harness.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../../database/migrations/', import.meta.url),
);
const LOCAL = 'postgresql://u:p@127.0.0.1:55432/notihouse_concurrency';
const enabled = { CONCURRENCY_TEST_ENABLED: ENABLE_VALUE };

describe('A. Barrera de destino (fail-closed)', () => {
  const refused = (env: NodeJS.ProcessEnv, url: string | undefined) =>
    expect(() => assertSafeConfiguration(env, url, 'X')).toThrow(
      UnsafeTargetError,
    );

  it('rechaza cualquier configuración que no sea exactamente la local', () => {
    expect(() => assertSafeConfiguration(enabled, LOCAL, 'X')).not.toThrow();
    refused({}, LOCAL);
    refused({ CONCURRENCY_TEST_ENABLED: 'true' }, LOCAL);
    refused(enabled, undefined);
    refused(enabled, 'no-es-url');
    refused(
      enabled,
      'postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/notihouse_concurrency',
    );
    refused(enabled, 'postgresql://u:p@10.0.0.5:55432/notihouse_concurrency');
    refused(enabled, 'postgresql://u:p@127.0.0.1:5432/notihouse_concurrency');
    refused(enabled, 'postgresql://u:p@127.0.0.1:55432/neondb');
    refused(
      enabled,
      'postgresql://neon:p@127.0.0.1:55432/notihouse_concurrency',
    );
    refused({ ...enabled, DATABASE_URL: LOCAL }, LOCAL);
    refused({ ...enabled, DATABASE_URL_DIRECT: LOCAL }, LOCAL);
    refused({ ...enabled, NODE_ENV: 'production' }, LOCAL);
    refused({ ...enabled, RENDER: 'true' }, LOCAL);
    refused({ ...enabled, CI: 'true' }, LOCAL);
  });

  it('los mensajes de rechazo no contienen credenciales', () => {
    try {
      assertSafeConfiguration(
        enabled,
        'postgresql://user:SECRET@host.neon.tech/db',
        'X',
      );
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET');
    }
  });

  const facts: TargetFacts = {
    database: 'notihouse_concurrency',
    role: OWNER_ROLE,
    versionNum: 180006,
    neonSetting: null,
    comment: 'notihouse-concurrency-disposable:abc',
    systemIdentifier: '1',
  };
  const expected = { role: OWNER_ROLE, marker: 'abc', systemIdentifier: '1' };

  it('compara lo que informa el servidor conectado', () => {
    expect(() => assertFacts(facts, expected)).not.toThrow();
    const bad = (patch: Partial<TargetFacts>) =>
      expect(() => assertFacts({ ...facts, ...patch }, expected)).toThrow(
        UnsafeTargetError,
      );
    bad({ database: 'neondb' });
    bad({ versionNum: 170005 });
    bad({ role: 'neondb_owner' });
    bad({ neonSetting: 'tenant' });
    bad({ comment: null });
    bad({ comment: 'notihouse-concurrency-disposable:otra' });
    bad({ systemIdentifier: '2' });
  });

  it('verifica la sesión real y rechaza marcas y bases equivocadas', async () => {
    const state = guardState();
    const client = new pg.Client({ connectionString: ownerUrl() });
    await client.connect();
    try {
      await assertConnectedTarget(client, OWNER_ROLE, state);
      await expect(
        assertConnectedTarget(client, OWNER_ROLE, {
          ...state,
          marker: 'otra',
        }),
      ).rejects.toThrow(UnsafeTargetError);
      await expect(
        assertConnectedTarget(client, OWNER_ROLE, {
          ...state,
          systemIdentifier: '0',
        }),
      ).rejects.toThrow(UnsafeTargetError);
      await expect(
        assertConnectedTarget(client, APP_ROLE, state),
      ).rejects.toThrow(UnsafeTargetError);
    } finally {
      await client.end();
    }
    const url = new URL(ownerUrl());
    url.pathname = '/postgres';
    const other = new pg.Client({ connectionString: url.toString() });
    await other.connect();
    try {
      await expect(
        assertConnectedTarget(other, OWNER_ROLE, state),
      ).rejects.toThrow(UnsafeTargetError);
    } finally {
      await other.end();
    }
  });

  it('el rol de aplicación también pasa la barrera con su identidad', async () => {
    const client = new pg.Client({ connectionString: appUrl() });
    await client.connect();
    try {
      const facts = await assertConnectedTarget(client, APP_ROLE, guardState());
      expect(Math.floor(facts.versionNum / 10_000)).toBe(18);
    } finally {
      await client.end();
    }
  });
});

describe('B. Migraciones reproducidas en PostgreSQL 18 real', () => {
  let owner: pg.Client;

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl() });
    await owner.connect();
  });
  afterAll(() => owner.end());

  it('18 tablas y 5 migraciones cuyo hash coincide con los archivos', async () => {
    const tables = await owner.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(tables.rows[0].n).toBe(18);
    const journal = JSON.parse(
      readFileSync(`${MIGRATIONS}meta/_journal.json`, 'utf8'),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toEqual([
      '0000_initial_schema',
      '0001_auth_accounts',
      '0002_alerts_and_proposal_applications',
      '0003_auto_generate_recurrence',
      '0004_proposal_actions_expansion',
      '0005_archive_obligation_action',
    ]);
    const applied = await owner.query<{ hash: string }>(
      `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    expect(applied.rows.map((r) => r.hash)).toEqual(
      journal.entries.map((e) =>
        createHash('sha256')
          .update(readFileSync(`${MIGRATIONS}${e.tag}.sql`, 'utf8'))
          .digest('hex'),
      ),
    );
  });

  it('el catálogo coincide con el que producen las mismas migraciones en PGlite', async () => {
    const CATALOG = {
      constraints: `SELECT conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) AS d
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
      indexes: `SELECT indexdef AS d FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
      triggers: `SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`,
      columns: `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS d
        FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`,
    };
    const lite = await createMigratedDatabase();
    const differences: Record<string, unknown> = {};
    const totals: Record<string, number> = {};
    for (const [name, query] of Object.entries(CATALOG)) {
      const real = (await owner.query<{ d: string }>(query)).rows.map(
        (r) => r.d,
      );
      const simulated = (
        await lite.client.query<{ d: string }>(query)
      ).rows.map((r) => r.d);
      totals[name] = real.length;
      const onlyReal = real.filter((d) => !simulated.includes(d));
      const onlyLite = simulated.filter((d) => !real.includes(d));
      if (onlyReal.length || onlyLite.length) {
        differences[name] = { onlyReal, onlyLite };
      }
    }
    const version = await lite.client.query<{ v: string }>(
      `SELECT current_setting('server_version') AS v`,
    );
    await lite.client.close();
    recordEvidence('catalog-vs-pglite', {
      pgliteVersion: version.rows[0]!.v,
      totals,
      differences,
    });
    expect(differences).toEqual({});
  });

  it('audit_events rechaza UPDATE, DELETE y TRUNCATE incluso al propietario', async () => {
    const triggers = await owner.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal AND tgenabled = 'O' ORDER BY 1`,
    );
    expect(triggers.rows.map((r) => r.tgname)).toEqual([
      'audit_events_reject_truncate',
      'audit_events_reject_update_delete',
    ]);
    const seeded = await owner.query(
      `INSERT INTO audit_events (correlation_id, actor_type, actor_id, component, action, result, metadata)
       VALUES (gen_random_uuid(), 'system', 'api', 'pg-suite', 'pg_suite.probe', 'success', '{}') RETURNING id`,
    );
    const id = seeded.rows[0].id as string;
    for (const statement of [
      `UPDATE audit_events SET action = 'x' WHERE id = '${id}'`,
      `DELETE FROM audit_events WHERE id = '${id}'`,
      `TRUNCATE audit_events`,
    ]) {
      await expect(owner.query(statement)).rejects.toThrow(/append-only/);
    }
  });
});

describe('C. Sesiones verdaderamente independientes', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());

  it('cuatro conexiones con PID, transacción y snapshot propios, abiertas a la vez', async () => {
    const clients = Array.from(
      { length: 4 },
      (_, i) =>
        new pg.Client({
          connectionString: ownerUrl(),
          application_name: `pg-suite-session-${i}`,
        }),
    );
    await Promise.all(clients.map((c) => c.connect()));
    try {
      await Promise.all(clients.map((c) => c.query('BEGIN')));
      const rows = await Promise.all(
        clients.map((c) =>
          c
            .query<{ pid: number; xid: string }>(
              `SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid`,
            )
            .then((r) => r.rows[0]!),
        ),
      );
      expect(new Set(rows.map((r) => r.pid)).size).toBe(4);
      expect(new Set(rows.map((r) => r.xid)).size).toBe(4);
      const open = await h.count(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE application_name LIKE 'pg-suite-session-%' AND state = 'idle in transaction'`,
      );
      expect(open).toBe(4);
      recordEvidence('independent-sessions', {
        pids: rows.map((r) => r.pid),
        xids: rows.map((r) => r.xid),
        simultaneousOpenTransactions: open,
      });
    } finally {
      await Promise.all(clients.map((c) => c.query('ROLLBACK')));
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('SKIP LOCKED omite, NOWAIT falla con 55P03 y el ROLLBACK libera', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const a = new pg.Client({ connectionString: ownerUrl() });
    const b = new pg.Client({ connectionString: ownerUrl() });
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(`SELECT 1 FROM obligations WHERE id = $1 FOR UPDATE`, [
        obligation,
      ]);
      const skipped = await b.query(
        `SELECT 1 FROM obligations WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [obligation],
      );
      expect(skipped.rowCount).toBe(0);
      await b.query('SAVEPOINT s');
      await expect(
        b.query(`SELECT 1 FROM obligations WHERE id = $1 FOR UPDATE NOWAIT`, [
          obligation,
        ]),
      ).rejects.toMatchObject({ code: '55P03' });
      await b.query('ROLLBACK TO SAVEPOINT s');
      await a.query('ROLLBACK');
      const freed = await b.query(
        `SELECT 1 FROM obligations WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [obligation],
      );
      expect(freed.rowCount).toBe(1);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  it('las dos instancias de la API compiten con sesiones distintas de sus pools', async () => {
    const user = await h.newUser();
    const obligation = await h.obligation(user);
    const occurrence = await h.occurrence(user, obligation);
    const path = `/obligations/${obligation}/occurrences/${occurrence}/confirm`;
    const { results, blocked } = await h.behindLock(
      'api-sessions-two-instances',
      { table: 'obligation_occurrences', id: occurrence },
      6,
      () =>
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 ? user.a : user.b).post(path, { result: 'paid' }),
        ),
    );
    expect(new Set(blocked.map((b) => b.pid)).size).toBe(6);
    expect(new Set(blocked.map((b) => b.application_name))).toEqual(
      new Set(['notihouse-pal-api-a', 'notihouse-pal-api-b']),
    );
    expect(statuses(results)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await h.audit('obligation_occurrence.confirm', occurrence)).toBe(1);
  });
});
