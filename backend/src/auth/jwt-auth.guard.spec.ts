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

  const contextFor = (headers: Record<string, string>, isPublic = false) => {
    const request: Record<string, unknown> = { headers };
    const reflector = {
      getAllAndOverride: () => isPublic,
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
    const guard = new JwtAuthGuard(reflector, jwt, {} as AuthService);
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
    const guard = new JwtAuthGuard(reflector, jwt, auth);

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
    const guard = new JwtAuthGuard(reflector, jwt, auth);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(auth.findActiveUser).not.toHaveBeenCalled();
  });
});
