const LEGACY_SSL_MODES = new Set(['prefer', 'require', 'verify-ca']);

/**
 * Prepara una cadena de conexión PostgreSQL para `pg`.
 *
 * `pg` 8 trata `sslmode=require` como `verify-full` y advierte que en la
 * versión 9 adoptará la semántica de libpq (más débil). Se fija explícitamente
 * `verify-full` para conservar la verificación completa del certificado.
 *
 * Lanza un error sin incluir la cadena, para no exponer credenciales.
 */
export function normalizeConnectionString(
  value: string | undefined,
  variableName: string,
): string {
  if (!value?.trim()) {
    throw new Error(`${variableName} no está configurada`);
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${variableName} no es una URL válida`);
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`${variableName} debe usar el protocolo postgresql://`);
  }

  const sslMode = url.searchParams.get('sslmode');
  if (sslMode && LEGACY_SSL_MODES.has(sslMode)) {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}

/** Descripción segura de una conexión, sin usuario ni contraseña. */
export function describeConnection(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}/${url.pathname.slice(1)}`;
}
