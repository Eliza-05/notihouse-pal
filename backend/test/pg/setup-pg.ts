import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeConfiguration } from '../../src/database/scripts/concurrency/target-guard.js';

/**
 * Entorno de la suite real. Falla en cerrado antes de importar la aplicación:
 * sin backend/.local/concurrency.env o con un destino dudoso no se ejecuta nada.
 * Las credenciales son las locales y descartables; nunca las de backend/.env.
 */
process.loadEnvFile(
  fileURLToPath(new URL('../../.local/concurrency.env', import.meta.url)),
);
assertSafeConfiguration(
  process.env,
  process.env.CONCURRENCY_TEST_DATABASE_URL_DIRECT,
  'CONCURRENCY_TEST_DATABASE_URL_DIRECT',
);
assertSafeConfiguration(
  process.env,
  process.env.CONCURRENCY_TEST_DATABASE_URL,
  'CONCURRENCY_TEST_DATABASE_URL',
);

process.env.JWT_SECRET = process.env.CONCURRENCY_TEST_JWT_SECRET;
process.env.N8N_SERVICE_TOKEN = process.env.CONCURRENCY_TEST_SERVICE_TOKEN;

const filesRoot = join(tmpdir(), `notihouse-pg-${randomUUID()}`);
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_PATH = join(filesRoot, 'storage');
process.env.STORAGE_UPLOAD_TMP_PATH = join(filesRoot, 'uploads');
process.env.STORAGE_MAX_PDF_BYTES = String(1024 * 1024);
process.env.STORAGE_MAX_AUDIO_BYTES = String(1024 * 1024);

afterAll(async () => {
  await rm(filesRoot, { recursive: true, force: true });
});
