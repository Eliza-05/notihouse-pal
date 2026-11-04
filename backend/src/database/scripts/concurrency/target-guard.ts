/**
 * Barrera de destino de las pruebas de concurrencia (Fase 4.2F.2).
 *
 * Toda operación que escriba en PostgreSQL desde estas herramientas debe pasar
 * por aquí. Falla en cerrado: cualquier condición que no se pueda comprobar
 * aborta antes de escribir. No existe ningún modo de forzarla.
 *
 * Comprobaciones:
 * - `assertSafeConfiguration`: lo declarado (variable de habilitación, host
 *   local, puerto, base exacta, sin Neon, distinta de las URL de la aplicación).
 * - `assertConnectedTarget`: lo REAL, consultado en la sesión ya conectada
 *   (base, versión 18, usuario, sin parámetros de Neon, marca de inicialización
 *   e identificador de sistema del servidor).
 */
import type pg from 'pg';

export const ENABLE_VALUE = 'disposable-postgres-only';
export const EXPECTED_DATABASE = 'notihouse_concurrency';
export const EXPECTED_PORT = '55432';
export const OWNER_ROLE = 'notihouse_conc_owner';
export const APP_ROLE = 'notihouse_app';
export const MARKER_PREFIX = 'notihouse-concurrency-disposable:';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const EXPECTED_MAJOR = 18;

export class UnsafeTargetError extends Error {
  constructor(reason: string) {
    super(`Destino rechazado (no se escribió nada): ${reason}`);
    this.name = 'UnsafeTargetError';
  }
}

const refuse = (reason: string): never => {
  throw new UnsafeTargetError(reason);
};

const parse = (value: string, variable: string): URL => {
  try {
    return new URL(value);
  } catch {
    // Sin el valor: puede contener credenciales.
    return refuse(`${variable} no es una URL válida`);
  }
};

/**
 * Valida la configuración SIN conectarse. Lanza con un mensaje sin credenciales.
 * `url` es la conexión que se va a usar; `env`, el entorno del proceso.
 */
export function assertSafeConfiguration(
  env: NodeJS.ProcessEnv,
  url: string | undefined,
  variable: string,
): void {
  if (env.CONCURRENCY_TEST_ENABLED !== ENABLE_VALUE) {
    refuse(`CONCURRENCY_TEST_ENABLED debe ser "${ENABLE_VALUE}"`);
  }
  if (env.NODE_ENV === 'production' || env.RENDER || env.CI) {
    refuse('solo se ejecuta en el equipo local de un desarrollador');
  }
  if (!url?.trim()) return refuse(`${variable} no está configurada`);
  const parsed = parse(url, variable);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    refuse(`${variable} debe usar el protocolo postgresql://`);
  }
  if (/neon/i.test(url) || /neon\.tech/i.test(parsed.hostname)) {
    refuse(`${variable} parece apuntar a Neon`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    refuse(`${variable} no apunta a localhost ni a 127.0.0.1`);
  }
  if (parsed.port !== EXPECTED_PORT) {
    refuse(`${variable} debe usar el puerto ${EXPECTED_PORT}`);
  }
  if (parsed.pathname !== `/${EXPECTED_DATABASE}`) {
    refuse(`${variable} debe conectarse a la base ${EXPECTED_DATABASE}`);
  }
  // Las cadenas normales de la aplicación no se reutilizan por error.
  for (const reserved of ['DATABASE_URL', 'DATABASE_URL_DIRECT']) {
    const value = env[reserved];
    if (value?.trim() && value.trim() === url.trim()) {
      refuse(`${variable} coincide con ${reserved}`);
    }
  }
}

export interface TargetFacts {
  database: string;
  role: string;
  versionNum: number;
  neonSetting: string | null;
  comment: string | null;
  systemIdentifier: string;
}

/** Hechos del servidor conectado (solo lectura). */
export async function readTargetFacts(
  client: Pick<pg.ClientBase, 'query'>,
): Promise<TargetFacts> {
  const { rows } = await client.query<{
    database: string;
    role: string;
    version_num: string;
    neon_setting: string | null;
    comment: string | null;
    system_identifier: string;
  }>(`
    SELECT current_database() AS database,
           current_user AS role,
           current_setting('server_version_num') AS version_num,
           coalesce(current_setting('neon.tenant_id', true),
                    current_setting('neon.timeline_id', true)) AS neon_setting,
           shobj_description(
             (SELECT oid FROM pg_database WHERE datname = current_database()),
             'pg_database') AS comment,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
  `);
  const row = rows[0]!;
  return {
    database: row.database,
    role: row.role,
    versionNum: Number(row.version_num),
    neonSetting: row.neon_setting,
    comment: row.comment,
    systemIdentifier: row.system_identifier,
  };
}

/** Compara los hechos del servidor con lo esperado. Pura, para poder probarla. */
export function assertFacts(
  facts: TargetFacts,
  expected: {
    role: string;
    marker?: string | null;
    systemIdentifier?: string | null;
  },
): void {
  if (facts.database !== EXPECTED_DATABASE) {
    refuse('la base conectada no es la esperada');
  }
  if (Math.floor(facts.versionNum / 10_000) !== EXPECTED_MAJOR) {
    refuse(`el servidor no es PostgreSQL ${EXPECTED_MAJOR}`);
  }
  if (facts.neonSetting) refuse('el servidor expone parámetros de Neon');
  if (facts.role !== expected.role) {
    refuse('el usuario conectado no es el esperado');
  }
  if (expected.marker !== undefined) {
    const wanted = expected.marker
      ? `${MARKER_PREFIX}${expected.marker}`
      : null;
    if (!wanted || facts.comment !== wanted) {
      refuse('la base no tiene la marca de inicialización de este entorno');
    }
  }
  if (
    expected.systemIdentifier !== undefined &&
    facts.systemIdentifier !== expected.systemIdentifier
  ) {
    refuse('el servidor no es la instancia inicializada para estas pruebas');
  }
}

export interface GuardState {
  marker: string;
  systemIdentifier: string;
}

/**
 * Verifica una sesión ya conectada. Debe ejecutarse con cada conexión antes de
 * su primera escritura. `state: null` solo lo usa la inicialización (aún no
 * existe la marca).
 */
export async function assertConnectedTarget(
  client: Pick<pg.ClientBase, 'query'>,
  role: string,
  state: GuardState | null,
): Promise<TargetFacts> {
  const facts = await readTargetFacts(client);
  assertFacts(
    facts,
    state
      ? { role, marker: state.marker, systemIdentifier: state.systemIdentifier }
      : { role },
  );
  return facts;
}
