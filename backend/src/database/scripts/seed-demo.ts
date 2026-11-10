/**
 * Seed de los cuatro usuarios de demostración (`npm run db:seed:demo`).
 *
 * - Solo se ejecuta en desarrollo local (rechaza NODE_ENV=production y Render).
 * - Verifica migraciones y que la base solo contenga datos de demostración.
 * - Es idempotente: no duplica cuentas ni reemplaza credenciales existentes.
 * - Genera una contraseña aleatoria distinta por usuario y guarda en
 *   PostgreSQL solo su hash Argon2id.
 * - Las contraseñas se escriben únicamente en backend/.local/ (ignorado por
 *   Git, permisos restringidos) y nunca se imprimen en la terminal.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { DEMO_USERS } from '../seed/demo-data.js';
import {
  applyDemoSeed,
  countDemoRows,
  inspectDemoSeedState,
} from '../seed/demo-seed.js';
import {
  assertIgnoredByGit,
  assertLocalDevelopment,
  connectVerified,
  CREDENTIALS_FILE,
  CREDENTIALS_HEADER,
  fail,
  LOCAL_DIR,
  writeRestrictedFile,
} from './local-script-support.js';

function chooseCredentialsFile(): string {
  if (!existsSync(CREDENTIALS_FILE)) return CREDENTIALS_FILE;
  // Nunca se sobrescribe un archivo existente.
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `${LOCAL_DIR}demo-credentials-${stamp}.txt`;
}

async function main(): Promise<void> {
  assertLocalDevelopment();
  const { db, pool } = await connectVerified();

  try {
    const state = await inspectDemoSeedState(db);
    if (state.existing.length > 0) {
      console.log(
        `Cuentas demo existentes (no se modifican): ${state.existing.join(', ')}`,
      );
    }
    if (state.missing.length === 0) {
      console.log(
        'Las cuatro cuentas demo ya existen. No se realizaron cambios.',
      );
      return;
    }

    const file = chooseCredentialsFile();
    assertIgnoredByGit(file);

    const credentials = state.missing.map((email) => ({
      email,
      password: randomBytes(18).toString('base64url'),
    }));
    if (
      new Set(credentials.map((c) => c.password)).size !== credentials.length
    ) {
      fail(
        'Las contraseñas generadas no son únicas; vuelve a ejecutar el seed',
      );
    }

    // El archivo se escribe antes de la transacción: si no se puede guardar de
    // forma segura, no se crea ninguna cuenta.
    const names = new Map(DEMO_USERS.map((u) => [u.email, u.displayName]));
    writeRestrictedFile(
      file,
      [
        ...CREDENTIALS_HEADER,
        ...credentials.map(
          (c) => `${names.get(c.email)}\t${c.email}\t${c.password}`,
        ),
        '',
      ].join('\n'),
      'create',
    );
    try {
      await applyDemoSeed(db, credentials);
    } catch (error) {
      unlinkSync(file);
      throw error;
    }

    console.log(`Cuentas demo creadas: ${state.missing.join(', ')}`);
    console.log('Filas de demostración por tabla:', await countDemoRows(db));
    console.log(`Credenciales guardadas localmente en: ${file}`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  // Solo el mensaje: nunca cadenas de conexión, contraseñas ni hashes.
  console.error(`✗ Seed cancelado: ${(error as Error).message}`);
  process.exitCode = 1;
}
