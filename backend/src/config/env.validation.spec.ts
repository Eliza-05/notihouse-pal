import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('applies development defaults when variables are missing', () => {
    expect(validateEnv({})).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      FRONTEND_URL: 'http://localhost:5173',
    });
  });

  it('parses valid values', () => {
    expect(
      validateEnv({
        NODE_ENV: 'production',
        PORT: '10000',
        FRONTEND_URL: 'https://app.example.com',
      }),
    ).toEqual({
      NODE_ENV: 'production',
      PORT: 10000,
      FRONTEND_URL: 'https://app.example.com',
    });
  });

  it.each(['abc', '0', '65536', '-1', '3000.5', '30 00'])(
    'rejects invalid PORT "%s"',
    (port) => {
      expect(() => validateEnv({ PORT: port })).toThrow(/PORT debe ser/);
    },
  );

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it.each(['localhost:5173', 'ftp://example.com', 'http://localhost:5173/app'])(
    'rejects invalid FRONTEND_URL "%s"',
    (url) => {
      expect(() => validateEnv({ FRONTEND_URL: url })).toThrow(/FRONTEND_URL/);
    },
  );
});
