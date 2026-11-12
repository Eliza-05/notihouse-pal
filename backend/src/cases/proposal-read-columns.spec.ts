import { describe, expect, it } from 'vitest';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import { caseProposals } from '../database/schema/index.js';
import { proposalColumns, proposalReadColumns } from './cases.service.js';

describe('proposalReadColumns (appliedAt en lecturas de propuestas)', () => {
  it('conserva todas las columnas de proposalColumns y añade appliedAt', () => {
    for (const key of Object.keys(proposalColumns)) {
      expect(proposalReadColumns).toHaveProperty(key);
    }
    expect(proposalReadColumns).toHaveProperty('appliedAt');
  });

  it('las escrituras (INSERT/UPDATE ... RETURNING) siguen usando solo proposalColumns, sin la subconsulta', () => {
    expect(Object.keys(proposalColumns)).not.toContain('appliedAt');
  });

  it('appliedAt es una subconsulta de solo lectura sobre proposal_applications, acotada a la propuesta', () => {
    const dialect = new PgDialect();
    const { sql } = dialect.sqlToQuery(proposalReadColumns.appliedAt.getSQL());
    expect(sql).toMatch(/from proposal_applications pa/i);
    expect(sql).toMatch(/pa\.proposal_id = "case_proposals"\."id"/);
    expect(sql).toMatch(/limit 1/i);
    expect(sql).not.toMatch(/insert|update|delete/i);
  });

  it('en un SELECT de una sola tabla la subconsulta sigue acotada a case_proposals.id (no a pa.id)', () => {
    const { sql } = new QueryBuilder()
      .select(proposalReadColumns)
      .from(caseProposals)
      .toSQL();
    expect(sql).toContain('pa.proposal_id = "case_proposals"."id"');
    expect(sql).not.toMatch(/pa\.proposal_id = "id"/);
  });
});
