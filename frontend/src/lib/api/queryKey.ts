/**
 * Claves de caché con el `user.id` (§7.6, §11.5): aíslan la caché entre
 * usuarios y entre cambios de sesión. `logout()`/el cambio de usuario ya
 * limpian la caché entera (AuthCacheSync), pero incluir el id aquí también
 * evita que una respuesta en vuelo de un usuario anterior se mezcle con la
 * del nuevo.
 */
export function queryKey(userId: string, ...rest: unknown[]) {
  return [userId, ...rest] as const
}
