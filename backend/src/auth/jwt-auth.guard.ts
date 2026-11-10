import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  UNAUTHENTICATED_MESSAGE,
} from './auth.constants.js';
import { AuthService } from './auth.service.js';
import type {
  AccessTokenPayload,
  AuthenticatedRequest,
} from './authenticated-user.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import {
  IS_SERVICE_ROUTE_KEY,
  type ServiceRequest,
} from './service-route.decorator.js';
import { SESSION_VERSION_PATTERN } from './session-version.js';
import { ServiceTokenVerifier } from './service-token.verifier.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard global con tres clases de rutas, evaluadas en este orden:
 * 1. `@ServiceRoute()` (rutas internas): solo el token de servicio; un JWT de
 *    usuario se rechaza. Prevalece sobre `@Public()`.
 * 2. `@Public()`: sin autenticación (solo salud y login).
 * 3. Resto: JWT de usuario; el token de servicio no sirve como usuario.
 * La identidad de usuario sale exclusivamente del JWT verificado y de la base de datos.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly serviceToken: ServiceTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isServiceRoute = this.reflector.getAllAndOverride<boolean>(
      IS_SERVICE_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isServiceRoute) return this.authenticateService(context);

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      // Firma, expiración, emisor, audiencia o algoritmo inválidos.
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }
    if (
      typeof payload.sub !== 'string' ||
      !UUID_PATTERN.test(payload.sub) ||
      typeof payload.iat !== 'number' ||
      typeof payload.sv !== 'string' ||
      !SESSION_VERSION_PATTERN.test(payload.sv)
    ) {
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }

    let user;
    try {
      user = await this.auth.findActiveUser(
        payload.sub,
        payload.iat,
        payload.sv,
      );
    } catch (error) {
      // Si no se puede validar la cuenta, se deniega el acceso (nunca se permite por omisión).
      this.logger.error(
        `No fue posible validar la sesión: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException('No fue posible validar la sesión');
    }
    if (!user) throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);

    request.user = user;
    return true;
  }

  private authenticateService(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ServiceRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token || !this.serviceToken.matches(token)) {
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }
    request.service = { name: 'n8n' };
    return true;
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    return null;
  }
  return token;
}
