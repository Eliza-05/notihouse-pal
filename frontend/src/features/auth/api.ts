import { api } from '../../lib/api/client'
import type { AuthenticatedUser } from '../../lib/api/types'

/** GET /auth/me: perfil del usuario autenticado (id, correo, nombre visible). */
export function getMe() {
  return api<AuthenticatedUser>('/auth/me')
}
