export const JWT_ALGORITHM = 'HS256';
export const JWT_ISSUER = 'notihouse-pal-api';
export const JWT_AUDIENCE = 'notihouse-pal-web';

/** Duración del token de acceso: 2 horas. No hay refresh tokens. */
export const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;

/** Intentos de login permitidos por IP en cada ventana. */
export const LOGIN_RATE_LIMIT = { limit: 5, ttlMs: 60_000 } as const;

/** Mensaje único para cualquier fallo de credenciales: no revela si la cuenta existe. */
export const INVALID_CREDENTIALS_MESSAGE = 'Credenciales inválidas';
export const UNAUTHENTICATED_MESSAGE = 'Autenticación requerida';
