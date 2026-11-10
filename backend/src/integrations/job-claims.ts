import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Reclamaciones de trabajos con "fencing" sin columnas adicionales.
 *
 * En cada reclamación el backend genera un token aleatorio de 32 bytes que
 * solo conoce el worker y guarda en `locked_by` la huella
 * `<workerId>#<sha256(token) en hex>`. Una nueva reclamación reemplaza la
 * huella, por lo que una respuesta tardía de una reclamación anterior ya no
 * coincide. Al completar o fallar se conserva `locked_by` (y se limpia
 * `locked_until`, como exige el check `workflow_jobs_lease`), lo que permite
 * reconocer un `complete`/`fail` duplicado de la misma reclamación.
 */

export const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const SEPARATOR = '#';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export function newClaimToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Valor de `locked_by` para una reclamación. Nunca contiene el token. */
export function claimFingerprint(workerId: string, token: string): string {
  return `${workerId}${SEPARATOR}${sha256(token).toString('hex')}`;
}

/**
 * Devuelve el worker de la reclamación si `token` corresponde a la huella
 * `lockedBy`; si no, `null`. Comparación en tiempo constante.
 */
export function matchClaim(
  lockedBy: string | null,
  token: string,
): string | null {
  if (!lockedBy) return null;
  const at = lockedBy.lastIndexOf(SEPARATOR);
  if (at <= 0) return null;
  const stored = Buffer.from(lockedBy.slice(at + 1), 'hex');
  const candidate = sha256(token);
  if (stored.length !== candidate.length) return null;
  return timingSafeEqual(stored, candidate) ? lockedBy.slice(0, at) : null;
}

/** Worker de una huella, para respuestas y auditoría (sin el resumen). */
export function workerOf(lockedBy: string | null): string | null {
  if (!lockedBy) return null;
  const at = lockedBy.lastIndexOf(SEPARATOR);
  return at > 0 ? lockedBy.slice(0, at) : null;
}

/** Espera exponencial entre reintentos: 30 s, 60 s, 120 s… hasta 1 hora. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
}
