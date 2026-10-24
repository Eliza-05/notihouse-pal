import type { Request } from 'express';

/**
 * Identidad establecida por el guard a partir de un JWT válido y de la base de
 * datos. Es la única fuente de `owner_id` para los módulos de negocio: nunca
 * se acepta un identificador de propietario enviado por el cliente.
 */
export interface AuthenticatedUser {
  profileId: string;
  email: string;
  displayName: string | null;
}

export interface AccessTokenPayload {
  sub: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };
