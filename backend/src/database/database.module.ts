import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { EnvironmentVariables } from '../config/env.validation.js';
import { normalizeConnectionString } from './connection-string.js';
import { DRIZZLE, PG_POOL } from './database.constants.js';
import { DatabaseService } from './database.service.js';
import * as schema from './schema/index.js';

/**
 * Infraestructura de acceso a PostgreSQL (Neon, conexión con pooling).
 * Global para que exista un único pool en toda la aplicación.
 * El pool se conecta de forma diferida: arrancar la API no exige que Neon
 * esté disponible, y nunca se ejecutan migraciones al iniciar.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const logger = new Logger('PostgresPool');
        const pool = new Pool({
          connectionString: normalizeConnectionString(
            config.get('DATABASE_URL', { infer: true }),
            'DATABASE_URL',
          ),
          application_name: 'notihouse-pal-api',
          max: 5,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
        });
        // Sin este manejador, un error en un cliente inactivo (p. ej. Neon
        // suspende el cómputo) terminaría el proceso.
        pool.on('error', (error) => {
          logger.error(`Error en conexión inactiva: ${error.message}`);
        });
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle({ client: pool, schema }),
    },
    DatabaseService,
  ],
  exports: [DRIZZLE, DatabaseService],
})
export class DatabaseModule {}
