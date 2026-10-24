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

const withoutComments = (sql: string) => sql.replace(/^\s*--(?!>).*$/gm, '');

describe('database migrations', () => {
  it('journal and SQL files match one to one', () => {
    expect(sqlFiles.sort()).toEqual(
      journal.entries.map((e) => `${e.tag}.sql`).sort(),
    );
  });

  it.each(sqlFiles)('%s contains no destructive statements', (file) => {
    const sql = withoutComments(
      readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'),
    );
    const found = DESTRUCTIVE_PATTERNS.filter(([, re]) => re.test(sql)).map(
      ([name]) => name,
    );
    expect(found).toEqual([]);
  });
});
