import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants.js';
import type { AuthService } from './auth.service.js';
import { extractBearerToken, JwtAuthGuard } from './jwt-auth.guard.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { IS_SERVICE_ROUTE_KEY } from './service-route.decorator.js';
import type { ServiceTokenVerifier } from './service-token.verifier.js';

describe('extractBearerToken', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['Basic abc', null],
    ['Bearer', null],
    ['Bearer a b', null],
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
  ])('%s -> %s', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });
});

describe('JwtAuthGuard', () => {
  const jwt = new JwtService({
    secret: process.env.JWT_SECRET,
    signOptions: { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 60 },
  });

  const SERVICE_TOKEN = 'service-token-for-unit-tests';
  const serviceToken = {
    matches: (candidate: string) => candidate === SERVICE_TOKEN,
  } as unknown as ServiceTokenVerifier;

  const contextFor = (
    headers: Record<string, string>,
    isPublic = false,
    isService = false,
  ) => {
    const request: Record<string, unknown> = { headers };
    const metadata: Record<string, boolean> = {
      [IS_PUBLIC_KEY]: isPublic,
      [IS_SERVICE_ROUTE_KEY]: isService,
    };
    const reflector = {
      getAllAndOverride: (key: string) => metadata[key] ?? false,
    } as unknown as Reflector;
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { request, reflector, context };
  };

  it('lets public routes through without a token', async () => {
    const { reflector, context } = contextFor({}, true);
    const guard = new JwtAuthGuard(
      reflector,
      jwt,
      {} as AuthService,
      serviceToken,
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies access (503) when the database cannot validate the session', async () => {
    const token = jwt.sign({ sub: randomUUID() });
    const { reflector, context, request } = contextFor({
      authorization: `Bearer ${token}`,
    });
    const auth = {
      findActiveUser: vi.fn().mockRejectedValue(new Error('connection lost')),
    } as unknown as AuthService;
    const guard = new JwtAuthGuard(reflector, jwt, auth, serviceToken);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(request.user).toBeUndefined();
  });

  it('rejects a valid token whose subject is not a UUID', async () => {
    const token = jwt.sign({ sub: 'admin' });
    const { reflector, context } = contextFor({
      authorization: `Bearer ${token}`,
    });
    const auth = { findActiveUser: vi.fn() } as unknown as AuthService;
    const guard = new JwtAuthGuard(reflector, jwt, auth, serviceToken);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(auth.findActiveUser).not.toHaveBeenCalled();
  });

  describe('service routes', () => {
    it('accepts the service token and sets a service identity, not a user', async () => {
      const { reflector, context, request } = contextFor(
        { authorization: `Bearer ${SERVICE_TOKEN}` },
        false,
        true,
      );
      const guard = new JwtAuthGuard(
        reflector,
        jwt,
        {} as AuthService,
        serviceToken,
      );
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.service).toEqual({ name: 'n8n' });
      expect(request.user).toBeUndefined();
    });

    it.each([
      ['no token', {}],
      ['wrong token', { authorization: 'Bearer wrong' }],
      [
        'user JWT',
        { authorization: `Bearer ${jwt.sign({ sub: randomUUID() })}` },
      ],
    ])('rejects %s', async (_case, headers) => {
      const auth = { findActiveUser: vi.fn() } as unknown as AuthService;
      const { reflector, context, request } = contextFor(headers, false, true);
      const guard = new JwtAuthGuard(reflector, jwt, auth, serviceToken);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(request.service).toBeUndefined();
      expect(auth.findActiveUser).not.toHaveBeenCalled();
    });

    it('never treats a service route as public, even if marked @Public()', async () => {
      const { reflector, context } = contextFor({}, true, true);
      const guard = new JwtAuthGuard(
        reflector,
        jwt,
        {} as AuthService,
        serviceToken,
      );
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects the service token on a user route', async () => {
      const auth = { findActiveUser: vi.fn() } as unknown as AuthService;
      const { reflector, context, request } = contextFor({
        authorization: `Bearer ${SERVICE_TOKEN}`,
      });
      const guard = new JwtAuthGuard(reflector, jwt, auth, serviceToken);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(request.service).toBeUndefined();
    });
  });
});
