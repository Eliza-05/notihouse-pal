/**
 * Operación del kill switch por el responsable operativo
 * (`npm run ops:kill-switch -- <orden>`). Conexión directa con
 * DATABASE_URL_DIRECT desde el equipo del responsable; nunca desde Render.
 *
 *   status
 *   activate --scope <alcance> --operator <nombre> --reason "<motivo>"
 *   resume   --scope <alcance> --operator <nombre> --reason "<causa corregida>"
 *            --test-evidence "<prueba controlada ejecutada>"
 *
 * Las órdenes que escriben exigen CONFIRM_KILL_SWITCH igual al nombre de la
 * base conectada (como la rotación de contraseñas). La reanudación SOLO
 * existe aquí: no hay ninguna ruta HTTP que la permita (SDD §6).
 */
import { sql } from 'drizzle-orm';
import {
  KILL_SWITCH_SCOPES,
  type KillSwitchScope,
} from '../../kill-switch/kill-switch.scopes.js';
import {
  type KillSwitchEntry,
  KillSwitchService,
} from '../../kill-switch/kill-switch.service.js';
import type { Database } from '../database.constants.js';
import { connectVerified, fail } from './local-script-support.js';

export type KillSwitchCommand =
  | { command: 'status' }
  | {
      command: 'activate';
      scope: KillSwitchScope;
      operator: string;
      reason: string;
    }
  | {
      command: 'resume';
      scope: KillSwitchScope;
      operator: string;
      reason: string;
      testEvidence: string;
    };

const USAGE =
  'Uso: status | activate --scope S --operator N --reason R | resume --scope S --operator N --reason R --test-evidence E';

export function parseKillSwitchArgs(argv: string[]): KillSwitchCommand {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (
      !key?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      fail(`Argumento inválido cerca de "${key ?? ''}". ${USAGE}`);
    }
    flags[key.slice(2)] = value;
  }
  if (command === 'status') return { command };
  if (command !== 'activate' && command !== 'resume') fail(USAGE);
  const scope = flags.scope as KillSwitchScope;
  if (!KILL_SWITCH_SCOPES.includes(scope)) {
    fail(`--scope debe ser uno de: ${KILL_SWITCH_SCOPES.join(', ')}`);
  }
  const required = (name: string) => {
    const value = flags[name]?.trim();
    if (!value || value.length < 3) {
      fail(`--${name} es obligatorio (mínimo 3 caracteres)`);
    }
    return value;
  };
  const operator = required('operator');
  const reason = required('reason');
  if (command === 'activate') return { command, scope, operator, reason };
  return {
    command,
    scope,
    operator,
    reason,
    testEvidence: required('test-evidence'),
  };
}

const show = (entries: KillSwitchEntry[]) => {
  if (entries.length === 0) {
    console.log('Ningún alcance se ha activado nunca.');
    return;
  }
  for (const e of entries) {
    console.log(
      `${e.active ? '■ ACTIVO ' : '□ inactivo'} ${e.scope.padEnd(22)} desde ${e.changedAt.toISOString()} · ${e.actor} · ${e.reason}`,
    );
  }
};

async function main(): Promise<void> {
  if (process.env.RENDER || process.env.CI) {
    fail('El kill switch se opera desde el equipo del responsable operativo');
  }
  const parsed = parseKillSwitchArgs(process.argv.slice(2));
  const { db, pool } = await connectVerified();
  try {
    const service = new KillSwitchService(db as unknown as Database);
    if (parsed.command === 'status') {
      show(await service.state());
      return;
    }
    const [info] = (
      await db.execute<{ database: string }>(
        sql`SELECT current_database() AS database`,
      )
    ).rows;
    if (process.env.CONFIRM_KILL_SWITCH !== info!.database) {
      fail(
        `Orden "${parsed.command}" no confirmada. Para ejecutarla: CONFIRM_KILL_SWITCH=${info!.database}`,
      );
    }
    if (parsed.command === 'activate') {
      const { changed } = await service.activate({
        scope: parsed.scope,
        reason: parsed.reason,
        trigger: 'manual',
        actor: `operador:${parsed.operator}`,
        actorType: 'system',
      });
      console.log(changed ? 'Activado.' : 'Ya estaba activo: sin cambios.');
    } else {
      const { changed } = await service.resume(parsed);
      console.log(changed ? 'Reanudado.' : 'No estaba activo: sin cambios.');
    }
    show(await service.state());
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('kill-switch.js')) {
  try {
    await main();
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
