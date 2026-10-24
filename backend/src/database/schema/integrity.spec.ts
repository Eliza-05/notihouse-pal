import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';

/**
 * Pruebas de integridad sobre PostgreSQL en memoria (PGlite), aplicando las
 * mismas migraciones versionadas que se usan en Neon. No se conecta a Neon y
 * no deja datos persistentes: cada prueba se revierte con ROLLBACK.
 */
const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../../database/migrations', import.meta.url),
);

let pg: PGlite;

const run = async (sql: string, params: unknown[] = []) =>
  (await pg.query<Record<string, unknown>>(sql, params)).rows;

const one = async (sql: string, params: unknown[] = []) =>
  (await run(sql, params))[0];

/** Ejecuta `sql` esperando un error que mencione `expected`, sin abortar la transacción. */
async function expectRejected(
  sql: string,
  params: unknown[],
  expected: string,
) {
  await pg.exec('SAVEPOINT expect_rejected');
  let message = '';
  try {
    await pg.query(sql, params);
  } catch (error) {
    message = (error as Error).message;
  }
  await pg.exec('ROLLBACK TO SAVEPOINT expect_rejected');
  expect(message, `se esperaba un error con "${expected}"`).toContain(expected);
}

interface Fixture {
  ownerA: string;
  ownerB: string;
  propertyA: string;
  propertyA2: string;
  obligationA: string;
  rentalA: string;
  caseA: string;
}

async function seed(): Promise<Fixture> {
  const ownerA = (await one(
    `INSERT INTO profiles (display_name) VALUES ('Propietario A') RETURNING id`,
  ))!.id as string;
  const ownerB = (await one(
    `INSERT INTO profiles (display_name) VALUES ('Propietario B') RETURNING id`,
  ))!.id as string;
  const propertyA = (await one(
    `INSERT INTO properties (owner_id, name) VALUES ($1, 'Apto 101') RETURNING id`,
    [ownerA],
  ))!.id as string;
  const propertyA2 = (await one(
    `INSERT INTO properties (owner_id, name) VALUES ($1, 'Casa') RETURNING id`,
    [ownerA],
  ))!.id as string;
  const obligationA = (await one(
    `INSERT INTO obligations (owner_id, property_id, provider_name, concept, category, expected_amount, due_day)
     VALUES ($1, $2, 'Empresa de energía', 'Energía Apto 101', 'electricity', 85000.50, 15) RETURNING id`,
    [ownerA, propertyA],
  ))!.id as string;
  const rentalA = (await one(
    `INSERT INTO rentals (owner_id, property_id, expected_amount, due_day, starts_on)
     VALUES ($1, $2, 1500000, 5, '2026-01-01') RETURNING id`,
    [ownerA, propertyA],
  ))!.id as string;
  const caseA = (await one(
    `INSERT INTO cases (owner_id, type, source, obligation_id)
     VALUES ($1, 'household_obligation', 'form', $2) RETURNING id`,
    [ownerA, obligationA],
  ))!.id as string;
  return { ownerA, ownerB, propertyA, propertyA2, obligationA, rentalA, caseA };
}

describe('database integrity (PGlite, migraciones versionadas)', () => {
  let f: Fixture;

  beforeAll(async () => {
    pg = new PGlite();
    await migrate(drizzle({ client: pg }), {
      migrationsFolder: MIGRATIONS_DIR,
    });
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec('BEGIN');
    f = await seed();
  });

  afterEach(async () => {
    await pg.exec('ROLLBACK');
  });

  it('creates all tables, defaults and the audit trigger', async () => {
    const tables = await run(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    // 15 tablas de la migración inicial + auth_accounts (0001).
    expect(tables[0]!.n).toBe(16);
    const triggers = await run(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal ORDER BY 1`,
    );
    expect(triggers.map((t) => t.tgname)).toEqual([
      'audit_events_reject_truncate',
      'audit_events_reject_update_delete',
    ]);
    const obligation = await one(
      `SELECT currency, expected_amount FROM obligations WHERE id = $1`,
      [f.obligationA],
    );
    expect(obligation).toEqual({
      currency: 'COP',
      expected_amount: '85000.50',
    });
  });

  describe('obligaciones y períodos', () => {
    const insertOccurrence = `INSERT INTO obligation_occurrences
      (obligation_id, owner_id, period_start, period_end, due_date, status, confirmed_at, confirmed_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

    it('never marks an occurrence as paid without human confirmation', async () => {
      await expectRejected(
        insertOccurrence,
        [
          f.obligationA,
          f.ownerA,
          '2026-10-01',
          '2026-10-31',
          '2026-10-15',
          'paid',
          null,
          null,
        ],
        'obligation_occurrences_confirmation',
      );
      await expectRejected(
        insertOccurrence,
        [
          f.obligationA,
          f.ownerA,
          '2026-10-01',
          '2026-10-31',
          '2026-10-15',
          'pending',
          new Date(),
          f.ownerA,
        ],
        'obligation_occurrences_confirmation',
      );
      await run(insertOccurrence, [
        f.obligationA,
        f.ownerA,
        '2026-10-01',
        '2026-10-31',
        '2026-10-15',
        'paid',
        new Date(),
        f.ownerA,
      ]);
    });

    it('rejects a duplicated period for the same obligation', async () => {
      const params = [
        f.obligationA,
        f.ownerA,
        '2026-11-01',
        '2026-11-30',
        '2026-11-15',
        'pending',
        null,
        null,
      ];
      await run(insertOccurrence, params);
      await expectRejected(
        insertOccurrence,
        params,
        'obligation_occurrences_period_unique',
      );
    });

    it('rejects negative amounts and invalid due days', async () => {
      await expectRejected(
        `INSERT INTO obligations (owner_id, provider_name, concept, category, expected_amount) VALUES ($1, 'X', 'Y', 'water', -1)`,
        [f.ownerA],
        'obligations_expected_amount_non_negative',
      );
      await expectRejected(
        `INSERT INTO obligations (owner_id, provider_name, concept, category, due_day) VALUES ($1, 'X', 'Y', 'water', 32)`,
        [f.ownerA],
        'obligations_due_day_range',
      );
    });
  });

  describe('aislamiento por propietario', () => {
    it('rejects an obligation linked to a property of another owner', async () => {
      await expectRejected(
        `INSERT INTO obligations (owner_id, property_id, provider_name, concept, category) VALUES ($1, $2, 'X', 'Y', 'gas')`,
        [f.ownerB, f.propertyA],
        'obligations_property_owner_fk',
      );
    });

    it('rejects a case referencing an obligation of another owner', async () => {
      await expectRejected(
        `INSERT INTO cases (owner_id, type, source, obligation_id) VALUES ($1, 'household_obligation', 'form', $2)`,
        [f.ownerB, f.obligationA],
        'cases_obligation_owner_fk',
      );
    });

    it('rejects a contract whose rental belongs to a different property', async () => {
      await expectRejected(
        `INSERT INTO contracts (owner_id, property_id, rental_id, starts_on, ends_on) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31')`,
        [f.ownerA, f.propertyA2, f.rentalA],
        'contracts_rental_property_owner_fk',
      );
      await run(
        `INSERT INTO contracts (owner_id, property_id, rental_id, starts_on, ends_on) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31')`,
        [f.ownerA, f.propertyA, f.rentalA],
      );
    });

    it('does not allow a case to reference more than one subject', async () => {
      await expectRejected(
        `INSERT INTO cases (owner_id, type, source, obligation_id, rental_id) VALUES ($1, 'household_obligation', 'form', $2, $3)`,
        [f.ownerA, f.obligationA, f.rentalA],
        'cases_single_subject',
      );
    });
  });

  describe('arriendos', () => {
    const insertCharge = `INSERT INTO rent_charges
      (rental_id, owner_id, period_start, period_end, expected_amount, due_date, status, confirmed_at, confirmed_by, confirmation_evidence)
      VALUES ($1, $2, '2026-10-01', '2026-10-31', 1500000, '2026-10-05', $3, $4, $5, $6)`;

    it('never marks rent as received without confirmation and evidence', async () => {
      await expectRejected(
        insertCharge,
        [f.rentalA, f.ownerA, 'received', new Date(), f.ownerA, null],
        'rent_charges_confirmation',
      );
      await run(insertCharge, [
        f.rentalA,
        f.ownerA,
        'received',
        new Date(),
        f.ownerA,
        'Transferencia ref. 123',
      ]);
    });
  });

  describe('HITL', () => {
    const insertHitl = `INSERT INTO hitl_requests (case_id, owner_id, assigned_to, decision_type, status, decision, responded_at)
      VALUES ($1, $2, $3, 'data_confirmation', $4, $5, $6) RETURNING created_at, due_at`;

    it('sets a 24 hour SLA by default', async () => {
      const row = await one(insertHitl, [
        f.caseA,
        f.ownerA,
        f.ownerA,
        'pending',
        null,
        null,
      ]);
      const hours =
        ((row!.due_at as Date).getTime() -
          (row!.created_at as Date).getTime()) /
        3_600_000;
      expect(hours).toBe(24);
    });

    it('never treats an expired request as a decision', async () => {
      await expectRejected(
        insertHitl,
        [
          f.caseA,
          f.ownerA,
          f.ownerA,
          'expired',
          JSON.stringify({ approved: true }),
          new Date(),
        ],
        'hitl_requests_decision',
      );
      await expectRejected(
        insertHitl,
        [f.caseA, f.ownerA, f.ownerA, 'approved', null, null],
        'hitl_requests_decision',
      );
      await run(insertHitl, [
        f.caseA,
        f.ownerA,
        f.ownerA,
        'expired',
        null,
        null,
      ]);
    });
  });

  describe('cola de trabajos', () => {
    const insertJob = `INSERT INTO workflow_jobs (case_id, job_type, idempotency_key, status, locked_by, locked_until, attempts, max_attempts)
      VALUES ($1, 'process_document', $2, $3, $4, $5, $6, 3)`;

    it('enforces idempotency keys', async () => {
      await run(insertJob, [
        f.caseA,
        'case-1:process_document',
        'pending',
        null,
        null,
        0,
      ]);
      await expectRejected(
        insertJob,
        [f.caseA, 'case-1:process_document', 'pending', null, null, 0],
        'workflow_jobs_idempotency_key_unique',
      );
    });

    it('requires a lease for claimed jobs and caps attempts', async () => {
      await expectRejected(
        insertJob,
        [f.caseA, 'k1', 'claimed', null, null, 1],
        'workflow_jobs_lease',
      );
      await expectRejected(
        insertJob,
        [f.caseA, 'k2', 'pending', null, null, 4],
        'workflow_jobs_attempts_range',
      );
      await run(insertJob, [
        f.caseA,
        'k3',
        'claimed',
        'n8n-worker-1',
        new Date(Date.now() + 60_000),
        1,
      ]);
    });
  });

  describe('auditoría append-only', () => {
    it.each([
      ['UPDATE', `UPDATE audit_events SET action = 'changed'`],
      ['DELETE', `DELETE FROM audit_events`],
      ['TRUNCATE', `TRUNCATE audit_events`],
    ])('rejects %s', async (_operation, statement) => {
      await run(
        `INSERT INTO audit_events (correlation_id, owner_id, actor_type, component, action, result)
         VALUES (gen_random_uuid(), $1, 'api', 'backend', 'obligation.create', 'success')`,
        [f.ownerA],
      );
      await expectRejected(statement, [], 'append-only');
    });
  });

  describe('historial y enlaces de pago', () => {
    it('does not delete a profile that still owns records', async () => {
      await expectRejected(
        `DELETE FROM profiles WHERE id = $1`,
        [f.ownerA],
        'foreign key constraint',
      );
    });

    it('only accepts https payment links, validated with a date', async () => {
      const provider = (await one(
        `INSERT INTO providers (name, slug) VALUES ('Empresa de agua', 'empresa-agua') RETURNING id`,
      ))!.id;
      await expectRejected(
        `INSERT INTO provider_payment_links (provider_id, url) VALUES ($1, 'http://pagos.example.com')`,
        [provider],
        'provider_payment_links_https',
      );
      await expectRejected(
        `INSERT INTO provider_payment_links (provider_id, url, validation_status) VALUES ($1, 'https://pagos.example.com', 'validated')`,
        [provider],
        'provider_payment_links_validated_at',
      );
    });
  });
});
