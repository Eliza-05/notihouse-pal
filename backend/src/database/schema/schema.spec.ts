import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from './index.js';

// El módulo exporta tablas y enums; se parte de unknown[] para filtrar solo las tablas.
const exportedValues: unknown[] = Object.values(schema);
const tables = exportedValues.filter((value): value is PgTable =>
  is(value, PgTable),
);
const configs = tables.map((table) => getTableConfig(table));
const byName = new Map(configs.map((c) => [c.name, c]));

const EXPECTED_TABLES = [
  'audit_events',
  'auth_accounts',
  'case_proposals',
  'cases',
  'contracts',
  'documents',
  'hitl_requests',
  'obligation_occurrences',
  'obligations',
  'profiles',
  'properties',
  'provider_payment_links',
  'providers',
  'rent_charges',
  'rentals',
  'workflow_jobs',
];

/** Tablas cuyos registros pertenecen a un propietario. */
const OWNER_SCOPED = [
  'properties',
  'obligations',
  'obligation_occurrences',
  'rentals',
  'rent_charges',
  'contracts',
  'cases',
  'documents',
  'case_proposals',
  'hitl_requests',
];

describe('database schema', () => {
  it('defines exactly the expected tables', () => {
    expect([...byName.keys()].sort()).toEqual(EXPECTED_TABLES);
  });

  it.each(EXPECTED_TABLES)('%s has a generated UUID primary key', (name) => {
    const idColumn = byName.get(name)!.columns.find((c) => c.name === 'id')!;
    expect(idColumn.primary).toBe(true);
    expect(idColumn.getSQLType()).toBe('uuid');
    expect(idColumn.hasDefault).toBe(true);
  });

  it.each(OWNER_SCOPED)('%s has a mandatory owner_id', (name) => {
    const owner = byName.get(name)!.columns.find((c) => c.name === 'owner_id');
    expect(owner?.notNull).toBe(true);
  });

  it('never cascades deletes (history is preserved)', () => {
    const actions = configs.flatMap((c) =>
      c.foreignKeys.map((fk) => `${c.name}:${fk.onDelete}`),
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.filter((a) => !a.endsWith(':restrict'))).toEqual([]);
  });

  it('stores money as numeric(14, 2), never as floating point', () => {
    const columns = configs.flatMap((c) => c.columns);
    const moneyColumns = columns.filter((c) => c.name.endsWith('amount'));
    expect(moneyColumns.length).toBeGreaterThan(0);
    for (const column of moneyColumns) {
      expect(column.getSQLType()).toBe('numeric(14, 2)');
    }
    expect(
      columns.filter((c) => /^(real|double precision)$/.test(c.getSQLType())),
    ).toEqual([]);
  });

  it('uses timezone-aware timestamps', () => {
    const timestamps = configs
      .flatMap((c) => c.columns)
      .filter((c) => c.getSQLType().startsWith('timestamp'));
    expect(timestamps.length).toBeGreaterThan(0);
    for (const column of timestamps) {
      expect(column.getSQLType()).toBe('timestamp with time zone');
    }
  });
});
