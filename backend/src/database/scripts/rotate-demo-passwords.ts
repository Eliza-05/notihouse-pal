/**
 * Rotación controlada de las contraseñas de las cuatro cuentas demo
 * (`npm run db:demo:rotate-passwords`). PREPARADO EN LA FASE 4.2F.1: NO
 * EJECUTADO EN NEON. Procedimiento completo y recuperación:
 * docs/security/backend-security-review.md.
 *
 * Garantías:
 * - Sin contraseñas en código, argumentos ni variables de entorno: el script
 *   las genera (aleatorias, individuales) y nunca las imprime.
 * - Por defecto es una simulación (sin escrituras). Solo escribe con
 *   CONFIRM_PASSWORD_ROTATION igual al nombre de la base conectada.
 * - Las contraseñas se guardan en ROTATION_OUTPUT_FILE (ruta absoluta, nueva,
 *   fuera del repositorio y de carpetas sincronizadas) ANTES del commit: si
 *   algo falla después, las credenciales vigentes ya están guardadas.
 * - Una sola transacción: o cambian las cuatro cuentas o ninguna. Cambiar
 *   `password_changed_at` invalida todos los JWT anteriores.
 */
import { existsSync, renameSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { sql } from 'drizzle-orm';
import {
  applyDemoPasswordRotation,
  planDemoPasswordRotation,
} from '../seed/password-rotation.js';
import { DEMO_USERS } from '../seed/demo-data.js';
import {
  connectVerified,
  fail,
  REPO_ROOT,
  writeRestrictedFile,
} from './local-script-support.js';

const OUTPUT_VARIABLE = 'ROTATION_OUTPUT_FILE';
const CONFIRM_VARIABLE = 'CONFIRM_PASSWORD_ROTATION';
const SYNCED_FOLDER = /onedrive|dropbox|google ?drive|icloud|box sync/i;

/** Ruta de salida segura: absoluta, nueva y fuera del repo y de carpetas sincronizadas. */
export function validateOutputPath(
  raw: string | undefined,
  repoRoot: string,
): string {
  if (!raw || !isAbsolute(raw)) {
    fail(`${OUTPUT_VARIABLE} debe ser una ruta absoluta a un archivo nuevo`);
  }
  const path = resolve(raw);
  const root = resolve(repoRoot);
  if (path === root || path.startsWith(root + sep)) {
    fail(`${OUTPUT_VARIABLE} no puede estar dentro del repositorio`);
  }
  if (SYNCED_FOLDER.test(path)) {
    fail(
      `${OUTPUT_VARIABLE} no puede estar en una carpeta sincronizada (OneDrive, Dropbox, iCloud…)`,
    );
  }
  if (existsSync(path) || existsSync(`${path}.pending`)) {
    fail(`${OUTPUT_VARIABLE} ya existe: elige un archivo nuevo`);
  }
  return path;
}

function assertOperatorMachine(): void {
  if (process.env.RENDER || process.env.CI) {
    fail('La rotación solo se ejecuta desde el equipo de un administrador');
  }
  if (process.env.NODE_ENV === 'production') {
    fail('La rotación no se ejecuta con NODE_ENV=production');
  }
}

async function main(): Promise<void> {
  assertOperatorMachine();
  const output = validateOutputPath(process.env[OUTPUT_VARIABLE], REPO_ROOT);
  const confirmation = process.env[CONFIRM_VARIABLE];

  const { db, pool } = await connectVerified();
  try {
    const [info] = (
      await db.execute<{ database: string }>(
        sql`SELECT current_database() AS database`,
      )
    ).rows;
    const apply = confirmation === info!.database;
    console.log(
      apply
        ? `Rotación CONFIRMADA sobre ${info!.database}.`
        : `Simulación (sin escrituras). Para aplicar: ${CONFIRM_VARIABLE}=${info!.database}`,
    );

    const planned = planDemoPasswordRotation();
    if (!apply) {
      for (const p of planned) console.log(`· rotaría ${p.email}`);
      return;
    }

    // 1. Guardar primero las contraseñas nuevas (marcadas como pendientes).
    const names = new Map(DEMO_USERS.map((u) => [u.email, u.displayName]));
    const body = (state: string) =>
      [
        '# NotiHouse-Pal — credenciales individuales de las cuentas demo',
        `# Estado: ${state}`,
        `# Generado: ${new Date().toISOString()}`,
        '# Guárdalas en un gestor de contraseñas y elimina este archivo.',
        '',
        ...planned.map(
          (p) => `${names.get(p.email)}\t${p.email}\t${p.password}`,
        ),
        '',
      ].join('\n');
    const pending = `${output}.pending`;
    writeRestrictedFile(
      pending,
      body('PENDIENTE (si ves este estado, verifica el inicio de sesión)'),
      'create',
    );

    // 2. Una transacción para las cuatro cuentas.
    let rotated;
    try {
      rotated = await applyDemoPasswordRotation(db, planned);
    } catch (error) {
      // Lo normal es que la transacción se revirtiera (siguen vigentes las
      // contraseñas anteriores). Pero si la conexión cayó durante el COMMIT el
      // resultado es incierto: el archivo pendiente NO se borra para no perder
      // el acceso. Verifica con un inicio de sesión cuál contraseña funciona
      // y elimina el archivo si son las anteriores.
      console.error(
        `El archivo pendiente se conserva para verificación: ${pending}`,
      );
      throw error;
    }

    // 3. Confirmado: el archivo pasa a vigente.
    writeRestrictedFile(pending, body('VIGENTE'), 'replace');
    renameSync(pending, output);
    for (const r of rotated) {
      console.log(
        `✓ ${r.email}: contraseña rotada (${r.passwordChangedAt.toISOString()}); sesiones anteriores invalidadas`,
      );
    }
    console.log(`Credenciales guardadas en: ${output}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('rotate-demo-passwords.js')) {
  try {
    await main();
  } catch (error) {
    console.error(`✗ Rotación cancelada: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
