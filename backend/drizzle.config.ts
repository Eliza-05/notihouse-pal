import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
import { normalizeConnectionString } from './src/database/connection-string.js';

// Las variables del sistema (p. ej. en CI) tienen prioridad sobre backend/.env.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  // Única ubicación oficial de migraciones (raíz del monorepositorio).
  out: '../database/migrations',
  // Las migraciones usan la conexión directa (sin pooler) de Neon.
  // `generate` y `check` no se conectan, por eso la URL solo se exige al migrar.
  dbCredentials: {
    get url() {
      return normalizeConnectionString(
        process.env.DATABASE_URL_DIRECT,
        'DATABASE_URL_DIRECT',
      );
    },
  },
  migrations: {
    schema: 'drizzle',
    table: '__drizzle_migrations',
  },
  strict: true,
  verbose: true,
});
