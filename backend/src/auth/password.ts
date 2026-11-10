import argon2 from 'argon2';

/**
 * Parámetros Argon2id: configuración mínima recomendada por OWASP
 * (Password Storage Cheat Sheet): m = 19 MiB, t = 2, p = 1.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Hash corrupto o con formato inesperado: nunca se considera válido.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifica contra un hash descartable para que un correo inexistente tarde lo
 * mismo que una contraseña incorrecta (evita enumerar cuentas por tiempo).
 */
export async function verifyAgainstDummyHash(password: string): Promise<false> {
  dummyHash ??= hashPassword('notihouse-pal-dummy-password');
  await verifyPassword(await dummyHash, password);
  return false;
}
