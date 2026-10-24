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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard global: toda ruta es privada salvo las marcadas con `@Public()`.
 * La identidad sale exclusivamente del JWT verificado y de la base de datos.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
      typeof payload.iat !== 'number'
    ) {
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }

    let user;
    try {
      user = await this.auth.findActiveUser(payload.sub, payload.iat);
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
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    return null;
  }
  return token;
}
