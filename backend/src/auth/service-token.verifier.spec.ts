import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { ServiceTokenVerifier } from './service-token.verifier.js';

const configWith = (token: string | undefined) =>
  ({ get: () => token }) as unknown as ConfigService<
    EnvironmentVariables,
    true
  >;

describe('ServiceTokenVerifier', () => {
  const token = randomBytes(32).toString('base64url');

  it('accepts only the exact configured token', () => {
    const verifier = new ServiceTokenVerifier(configWith(token));
    expect(verifier.matches(token)).toBe(true);
    expect(verifier.matches(`${token}x`)).toBe(false);
    expect(verifier.matches(token.slice(0, -1))).toBe(false);
    expect(verifier.matches('')).toBe(false);
  });

  it('rejects everything when no token is configured', () => {
    const verifier = new ServiceTokenVerifier(configWith(undefined));
    expect(verifier.matches('')).toBe(false);
    expect(verifier.matches(token)).toBe(false);
  });
});
