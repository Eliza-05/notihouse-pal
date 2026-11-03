/**
 * Sonda de bloqueos entre DOS conexiones independientes (Fase 4.2F.2).
 * PREPARADA EN LA FASE 4.2F.1: NO EJECUTADA.
 *
 * No modifica datos: ambas transacciones terminan en ROLLBACK y no hay
 * INSERT/UPDATE/DELETE ni DDL. Verifica en el PostgreSQL real que:
 * 1. `FOR UPDATE SKIP LOCKED` omite la fila bloqueada por la otra conexión.
 * 2. `FOR UPDATE NOWAIT` falla con 55P03 si la fila está bloqueada.
 * 3. Al liberar (ROLLBACK) la fila vuelve a estar disponible.
 * Nota: un bloqueo de fila marca la tupla (xmax) sin cambiar su contenido;
 * no se crean versiones nuevas ni eventos de auditoría.
 *
 * Requiere LOCK_PROBE_CONFIRM=lock-only-rollback y DATABASE_URL_DIRECT.
 */
import pg from 'pg';
import { normalizeConnectionString } from '../../connection-string.js';
import { fail } from '../local-script-support.js';

export const LOCK_PROBE_ACK = 'lock-only-rollback';

/** Tabla con filas en la base de demostración; se lee por id, sin filtros de negocio. */
const TABLE = 'obligation_occurrences';

async function main(): Promise<void> {
  if (process.env.LOCK_PROBE_CONFIRM !== LOCK_PROBE_ACK) {
    fail(`LOCK_PROBE_CONFIRM debe ser "${LOCK_PROBE_ACK}"`);
  }
  const connectionString = normalizeConnectionString(
    process.env.DATABASE_URL_DIRECT,
    'DATABASE_URL_DIRECT',
  );
  const a = new pg.Client({
    connectionString,
    application_name: 'lock-probe-a',
  });
  const b = new pg.Client({
    connectionString,
    application_name: 'lock-probe-b',
  });
  await a.connect();
  await b.connect();
  const results: string[] = [];
  try {
    const [pidA, pidB] = await Promise.all([
      a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
      b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
    ]);
    if (pidA.rows[0]!.pid === pidB.rows[0]!.pid) {
      fail('Las dos conexiones comparten backend: la prueba no es válida');
    }
    await a.query('BEGIN');
    await b.query('BEGIN');
    await a.query(`SET LOCAL lock_timeout = '5s'`);
    await b.query(`SET LOCAL lock_timeout = '5s'`);
    const locked = await a.query<{ id: string }>(
      `SELECT id FROM ${TABLE} ORDER BY id LIMIT 1 FOR UPDATE`,
    );
    const target = locked.rows[0]?.id;
    if (!target) fail(`${TABLE} no tiene filas para la sonda`);

    const skipped = await b.query<{ id: string }>(
      `SELECT id FROM ${TABLE} WHERE id = $1 FOR UPDATE SKIP LOCKED`,
      [target],
    );
    results.push(
      skipped.rowCount === 0
        ? '✓ SKIP LOCKED omitió la fila bloqueada por la otra conexión'
        : '✗ SKIP LOCKED devolvió una fila bloqueada',
    );
    await b.query('SAVEPOINT nowait_probe');
    try {
      await b.query(`SELECT id FROM ${TABLE} WHERE id = $1 FOR UPDATE NOWAIT`, [
        target,
      ]);
      results.push('✗ NOWAIT obtuvo una fila bloqueada');
    } catch (error) {
      results.push(
        (error as { code?: string }).code === '55P03'
          ? '✓ NOWAIT falló con 55P03 (lock_not_available)'
          : `✗ NOWAIT falló con otro código: ${(error as { code?: string }).code}`,
      );
      await b.query('ROLLBACK TO SAVEPOINT nowait_probe');
    }
    await a.query('ROLLBACK');
    const freed = await b.query<{ id: string }>(
      `SELECT id FROM ${TABLE} WHERE id = $1 FOR UPDATE SKIP LOCKED`,
      [target],
    );
    results.push(
      freed.rowCount === 1
        ? '✓ Tras el ROLLBACK la fila volvió a estar disponible'
        : '✗ La fila siguió bloqueada tras el ROLLBACK',
    );
  } finally {
    await a.query('ROLLBACK').catch(() => undefined);
    await b.query('ROLLBACK').catch(() => undefined);
    await a.end();
    await b.end();
  }
  for (const line of results) console.log(line);
  if (results.some((l) => l.startsWith('✗'))) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('lock-probe.js')) {
  try {
    await main();
  } catch (error) {
    console.error(`✗ Sonda cancelada: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
