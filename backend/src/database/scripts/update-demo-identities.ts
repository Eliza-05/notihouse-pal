/**
 * Actualiza las cuentas demo creadas con los correos anteriores
 * (`*@notihouse.test`) a las identidades oficiales (`npm run db:demo:update-identities`).
 *
 * La contraseña se recibe solo por la variable de entorno temporal
 * DEMO_ACCOUNTS_PASSWORD (nunca desde código, argumentos ni archivos
 * versionados) y no se imprime. Cada cuenta recibe su propio hash Argon2id.
 * Conserva UUID y datos de negocio; los JWT anteriores quedan invalidados.
 */
import { DEMO_USERS } from '../seed/demo-data.js';
import { updateLegacyDemoIdentities } from '../seed/demo-seed.js';
import {
  assertIgnoredByGit,
  assertLocalDevelopment,
  connectVerified,
  CREDENTIALS_FILE,
  CREDENTIALS_HEADER,
  fail,
  writeRestrictedFile,
} from './local-script-support.js';

const PASSWORD_VARIABLE = 'DEMO_ACCOUNTS_PASSWORD';

function takePassword(): string {
  const password = process.env[PASSWORD_VARIABLE];
  // Se retira del entorno del proceso en cuanto se lee.
  delete process.env[PASSWORD_VARIABLE];
  if (!password || password.length < 8 || password.length > 256) {
    fail(
      `${PASSWORD_VARIABLE} debe definirse con una contraseña de 8 a 256 caracteres`,
    );
  }
  return password;
}

async function main(): Promise<void> {
  assertLocalDevelopment();
  const password = takePassword();
  assertIgnoredByGit(CREDENTIALS_FILE);

  const { db, pool } = await connectVerified();
  try {
    const updated = await updateLegacyDemoIdentities(db, password);

    // Después del commit: se reescribe el archivo local en el mismo lugar.
    const names = new Map(DEMO_USERS.map((u) => [u.email, u.displayName]));
    writeRestrictedFile(
      CREDENTIALS_FILE,
      [
        ...CREDENTIALS_HEADER,
        '# Contraseña temporal compartida solo para la demostración académica;',
        '# debe sustituirse por contraseñas únicas antes de cualquier despliegue público.',
        '',
        ...updated.map((u) => `${names.get(u.email)}\t${u.email}\t${password}`),
        '',
      ].join('\n'),
      'replace',
    );

    for (const u of updated) {
      console.log(
        `✓ ${u.previousEmail} → ${u.email} (${u.displayName}) | perfil ${u.profileId} | cuenta ${u.accountId}`,
      );
    }
    console.log(`Credenciales actualizadas localmente en: ${CREDENTIALS_FILE}`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`✗ Actualización cancelada: ${(error as Error).message}`);
  process.exitCode = 1;
}
