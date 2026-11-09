import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../database/migrations', import.meta.url),
);

interface Journal {
  entries: { idx: number; tag: string }[];
}

const journal = JSON.parse(
  readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, 'utf8'),
) as Journal;

const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

/**
 * Patrones destructivos. Cualquier migración futura que los necesite requiere
 * una revisión y autorización explícitas (ver docs/architecture/database-design.md).
 */
const DESTRUCTIVE_PATTERNS: [string, RegExp][] = [
  ['DROP', /^\s*DROP\b/im],
  ['TRUNCATE', /^\s*TRUNCATE\b/im],
  ['DELETE', /^\s*DELETE\s+FROM\b/im],
  ['UPDATE masivo', /^\s*UPDATE\s+\S+\s+SET\b/im],
  ['ALTER ... DROP', /\bALTER\s+(TABLE|TYPE)\b[^;]*\bDROP\b/i],
  ['ALTER ... RENAME', /\bALTER\s+(TABLE|TYPE)\b[^;]*\bRENAME\b/i],
  ['ALTER COLUMN ... TYPE', /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i],
];

/**
 * Lista CERRADA de relajaciones aprobadas (D8, migración 0004): solo estas dos
 * sentencias exactas pueden contener `DROP NOT NULL`. Relajan `NOT NULL` sin
 * perder datos (las filas existentes ya tienen valor) y son necesarias para
 * que una aplicación de propuesta pueda apuntar a una obligación o a un
 * arriendo sin período. Cualquier otro `DROP` (columna, restricción, tabla,
 * otro `NOT NULL`) sigue rechazado.
 */
const APPROVED_STATEMENTS: RegExp[] = [
  /ALTER TABLE "proposal_applications" ALTER COLUMN "obligation_id" DROP NOT NULL;?/g,
  /ALTER TABLE "proposal_applications" ALTER COLUMN "occurrence_id" DROP NOT NULL;?/g,
];

const withoutApproved = (sql: string) =>
  APPROVED_STATEMENTS.reduce((acc, re) => acc.replace(re, ''), sql);

const withoutComments = (sql: string) => sql.replace(/^\s*--(?!>).*$/gm, '');

describe('database migrations', () => {
  it('journal and SQL files match one to one', () => {
    expect(sqlFiles.sort()).toEqual(
      journal.entries.map((e) => `${e.tag}.sql`).sort(),
    );
  });

  it.each(sqlFiles)('%s contains no destructive statements', (file) => {
    const sql = withoutApproved(
      withoutComments(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8')),
    );
    const found = DESTRUCTIVE_PATTERNS.filter(([, re]) => re.test(sql)).map(
      ([name]) => name,
    );
    expect(found).toEqual([]);
  });
});

describe('destructive-statement guard', () => {
  const flagged = (sql: string) =>
    DESTRUCTIVE_PATTERNS.filter(([, re]) => re.test(withoutApproved(sql))).map(
      ([name]) => name,
    );

  it('still rejects DROP NOT NULL on any other column', () => {
    expect(
      flagged('ALTER TABLE "obligations" ALTER COLUMN "provider_name" DROP NOT NULL;'),
    ).toContain('ALTER ... DROP');
  });

  it('still rejects DROP COLUMN / CONSTRAINT / TABLE and DROP DEFAULT', () => {
    expect(flagged('ALTER TABLE "x" DROP COLUMN "y";')).toContain('ALTER ... DROP');
    expect(flagged('ALTER TABLE "x" DROP CONSTRAINT "y";')).toContain('ALTER ... DROP');
    expect(flagged('ALTER TABLE "x" ALTER COLUMN "y" DROP DEFAULT;')).toContain('ALTER ... DROP');
    expect(flagged('DROP TABLE "x";')).toContain('DROP');
  });

  it('accepts only the two approved proposal_applications relaxations', () => {
    expect(
      flagged(
        'ALTER TABLE "proposal_applications" ALTER COLUMN "obligation_id" DROP NOT NULL;--> statement-breakpoint\nALTER TABLE "proposal_applications" ALTER COLUMN "occurrence_id" DROP NOT NULL;',
      ),
    ).toEqual([]);
    expect(
      flagged('ALTER TABLE "proposal_applications" ALTER COLUMN "applied_by" DROP NOT NULL;'),
    ).toContain('ALTER ... DROP');
  });
});
