import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

/** Token del `pg.Pool` compartido por toda la aplicación. */
export const PG_POOL = Symbol('PG_POOL');

/** Token de la instancia de Drizzle. Inyectar con `@Inject(DRIZZLE)`. */
export const DRIZZLE = Symbol('DRIZZLE');

export type Database = NodePgDatabase<typeof schema>;
