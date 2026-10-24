import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from './database.constants.js';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Comprueba la conectividad con `SELECT 1`. No forma parte del endpoint de salud. */
  async ping(): Promise<boolean> {
    const result = await this.pool.query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.logger.log('Pool de PostgreSQL cerrado');
  }
}
