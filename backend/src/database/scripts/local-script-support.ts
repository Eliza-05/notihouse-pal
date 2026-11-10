/**
 * Utilidades compartidas por los scripts locales de datos de demostración
 * (`db:seed:demo`, `db:demo:update-identities`).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { normalizeConnectionString } from '../connection-string.js';
import * as schema from '../schema/index.js';
import { SeedPreconditionError } from '../seed/demo-seed.js';

export const REPO_ROOT = fileURLToPath(
  new URL('../../../../', import.meta.url),
);
export const LOCAL_DIR = fileURLToPath(
  new URL('../../../.local/', import.meta.url),
);
export const CREDENTIALS_FILE = `${LOCAL_DIR}demo-credentials.txt`;
const JOURNAL = fileURLToPath(
  new URL(
    '../../../../database/migrations/meta/_journal.json',
    import.meta.url,
  ),
);

export function fail(message: string): never {
  throw new SeedPreconditionError(message);
}

/** Solo en el equipo local de un desarrollador, con NODE_ENV=development. */
export function assertLocalDevelopment(): void {
  if (process.env.NODE_ENV === 'production') {
    fail('Este script no se ejecuta con NODE_ENV=production');
  }
  if (process.env.NODE_ENV !== 'development') {
    fail('Este script solo se ejecuta con NODE_ENV=development (backend/.env)');
  }
  if (process.env.RENDER || process.env.CI) {
    fail('Este script solo se ejecuta en el equipo local de un desarrollador');
  }
}

export function assertIgnoredByGit(file: string): void {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', file], {
      stdio: 'ignore',
    });
  } catch {
    fail(`No se pudo confirmar que ${file} está excluido por .gitignore`);
  }
  try {
    execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', '--error-unmatch', file],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    return; // No versionado: correcto.
  }
  fail(`${file} está versionado en Git`);
}

/**
 * Escribe un archivo local con permisos restringidos al usuario actual.
 * `mode: 'create'` nunca sobrescribe; `mode: 'replace'` reescribe el archivo
 * existente en el mismo lugar (sin crear copias) conservando su ACL.
 */
export function writeRestrictedFile(
  file: string,
  content: string,
  mode: 'create' | 'replace',
): void {
  mkdirSync(LOCAL_DIR, { recursive: true });
  const isNew = mode === 'create' || !existsSync(file);
  writeFileSync(file, content, { flag: isNew ? 'wx' : 'w', mode: 0o600 });
  if (!isNew) return;

  if (process.platform === 'win32') {
    const user = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME;
    try {
      // Quita permisos heredados y deja acceso solo al usuario actual.
      execFileSync(
        'icacls',
        [file, '/inheritance:r', '/grant:r', `${user}:F`],
        {
          stdio: 'ignore',
        },
      );
    } catch {
      unlinkSync(file);
      fail(
        'No se pudieron restringir los permisos del archivo de credenciales',
      );
    }
  }
}

export const CREDENTIALS_HEADER = [
  '# NotiHouse-Pal — credenciales de los usuarios de demostración',
  `# Generado: ${new Date().toISOString()}`,
  '# ARCHIVO LOCAL Y TEMPORAL: no lo subas a Git ni lo compartas por canales públicos.',
  '# Guarda estas credenciales en un gestor de contraseñas y elimina este archivo.',
  '',
];

/** Conexión directa (administración) con verificación del historial de migraciones. */
export async function connectVerified() {
  const connectionString = normalizeConnectionString(
    process.env.DATABASE_URL_DIRECT,
    'DATABASE_URL_DIRECT',
  );
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    application_name: 'notihouse-pal-demo-scripts',
  });
  const db = drizzle({ client: pool, schema });

  try {
    const journal = JSON.parse(readFileSync(JOURNAL, 'utf8')) as {
      entries: unknown[];
    };
    const info = await db.execute<{ database: string; applied: number }>(sql`
      SELECT current_database() AS database,
             (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS applied
    `);
    const { database, applied } = info.rows[0]!;
    const region = new URL(connectionString).hostname
      .split('.')
      .slice(1, -2)
      .join('.');
    console.log(`Base de datos: ${database} (${region})`);
    if (applied !== journal.entries.length) {
      fail(
        `Migraciones aplicadas (${applied}) distintas de las versionadas (${journal.entries.length}). Ejecuta npm run db:migrate primero.`,
      );
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  return { db, pool };
}
