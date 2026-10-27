import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { UNAUTHENTICATED_MESSAGE } from './auth.constants.js';

export const IS_SERVICE_ROUTE_KEY = 'isServiceRoute';
/** Esquema de Swagger de las rutas internas (sin valor de ejemplo). */
export const SERVICE_SECURITY_SCHEME = 'service';

/** Identidad del componente de automatización, distinta de un usuario. */
export interface AuthenticatedService {
  name: 'n8n';
}

export type ServiceRequest = Request & { service?: AuthenticatedService };

/**
 * Marca una ruta (o controlador) como interna: el guard global exige el token
 * de servicio y NUNCA un JWT de usuario. Prevalece sobre `@Public()`, así que
 * una ruta interna no puede quedar abierta por error.
 */
export const ServiceRoute = () =>
  applyDecorators(
    SetMetadata(IS_SERVICE_ROUTE_KEY, true),
    ApiBearerAuth(SERVICE_SECURITY_SCHEME),
  );

/** Inyecta la identidad de servicio establecida por el guard global. */
export const CurrentService = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedService => {
    const request = ctx.switchToHttp().getRequest<ServiceRequest>();
    if (!request.service) {
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }
    return request.service;
  },
);
