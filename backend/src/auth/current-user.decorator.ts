import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from './authenticated-user.js';
import { UNAUTHENTICATED_MESSAGE } from './auth.constants.js';

/**
 * Inyecta el usuario autenticado por el guard global.
 * Uso: `handler(@CurrentUser() user: AuthenticatedUser)`; el propietario de
 * los datos es siempre `user.profileId`.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      // Solo ocurre si se usa en una ruta @Public(): se rechaza en lugar de continuar sin identidad.
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }
    return request.user;
  },
);
