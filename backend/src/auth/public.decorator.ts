import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Excluye un endpoint del guard global de autenticación.
 * Todas las rutas son privadas por defecto; usar solo con justificación.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
