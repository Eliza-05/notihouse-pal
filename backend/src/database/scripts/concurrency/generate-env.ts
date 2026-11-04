/**
 * Genera las credenciales locales del entorno descartable en
 * backend/.local/concurrency.env (ignorado por Git). Nunca las imprime, no las
 * sobrescribe y no lee backend/.env: son independientes de las reales.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  assertIgnoredByGit,
  LOCAL_DIR,
  writeRestrictedFile,
} from '../local-script-support.js';
import {
  APP_ROLE,
  ENABLE_VALUE,
  EXPECTED_DATABASE,
  EXPECTED_PORT,
  OWNER_ROLE,
} from './target-guard.js';

export const CONCURRENCY_ENV_FILE = `${LOCAL_DIR}concurrency.env`;

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const url = (role: string, password: string) =>
  `postgresql://${role}:${password}@127.0.0.1:${EXPECTED_PORT}/${EXPECTED_DATABASE}`;

if (process.argv[1]?.endsWith('generate-env.js')) {
  if (existsSync(CONCURRENCY_ENV_FILE)) {
    console.log('✓ Las credenciales locales ya existen; no se modificaron.');
  } else {
    assertIgnoredByGit(CONCURRENCY_ENV_FILE);
    const ownerPassword = secret();
    const appPassword = secret();
    writeRestrictedFile(
      CONCURRENCY_ENV_FILE,
      [
        '# Credenciales del PostgreSQL DESCARTABLE de pruebas. No son de Neon.',
        `CONCURRENCY_TEST_ENABLED=${ENABLE_VALUE}`,
        `CONCURRENCY_OWNER_PASSWORD=${ownerPassword}`,
        `CONCURRENCY_APP_PASSWORD=${appPassword}`,
        `CONCURRENCY_TEST_DATABASE_URL_DIRECT=${url(OWNER_ROLE, ownerPassword)}`,
        `CONCURRENCY_TEST_DATABASE_URL=${url(APP_ROLE, appPassword)}`,
        `CONCURRENCY_TEST_MARKER=${randomBytes(16).toString('hex')}`,
        `CONCURRENCY_TEST_JWT_SECRET=${secret(48)}`,
        `CONCURRENCY_TEST_SERVICE_TOKEN=${secret(48)}`,
        '',
      ].join('\n'),
      'create',
    );
    console.log('✓ Credenciales locales generadas en backend/.local/.');
  }
}
