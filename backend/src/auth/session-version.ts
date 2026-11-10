import { createHash } from 'node:crypto';

/** Formato del claim `sv` (SHA-256 truncado, base64url). */
export const SESSION_VERSION_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Versión de sesión: huella opaca de `password_changed_at` con precisión de
 * milisegundos. Se incluye en cada JWT (`sv`) y el guard exige que coincida
 * con el valor vigente, de modo que CUALQUIER cambio de contraseña invalida
 * los tokens anteriores, incluso los emitidos en el mismo segundo (`iat`
 * solo tiene precisión de segundos). No requiere columnas nuevas.
 */
export function sessionVersion(
  profileId: string,
  passwordChangedAt: Date,
): string {
  return createHash('sha256')
    .update(`${profileId}:${passwordChangedAt.getTime()}`)
    .digest('base64url')
    .slice(0, 22);
}
