import { validateEnv } from './env.validation.js';

// Cadena de ejemplo para pruebas; no corresponde a ningún servidor real.
const SAMPLE_DATABASE_URL =
  'postgresql://app_user:sample-password@db.example.com/app?sslmode=require';

describe('validateEnv', () => {
  it('applies development defaults when variables are missing', () => {
    expect(validateEnv({ DATABASE_URL: SAMPLE_DATABASE_URL })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      FRONTEND_URL: 'http://localhost:5173',
      DATABASE_URL: SAMPLE_DATABASE_URL,
    });
  });

  it('parses valid values', () => {
    expect(
      validateEnv({
        NODE_ENV: 'production',
        PORT: '10000',
        FRONTEND_URL: 'https://app.example.com',
        DATABASE_URL: SAMPLE_DATABASE_URL,
      }),
    ).toEqual({
      NODE_ENV: 'production',
      PORT: 10000,
      FRONTEND_URL: 'https://app.example.com',
      DATABASE_URL: SAMPLE_DATABASE_URL,
    });
  });

  it.each(['abc', '0', '65536', '-1', '3000.5', '30 00'])(
    'rejects invalid PORT "%s"',
    (port) => {
      expect(() =>
        validateEnv({ PORT: port, DATABASE_URL: SAMPLE_DATABASE_URL }),
      ).toThrow(/PORT debe ser/);
    },
  );

  it('rejects an unknown NODE_ENV', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'staging', DATABASE_URL: SAMPLE_DATABASE_URL }),
    ).toThrow(/NODE_ENV/);
  });

  it.each(['localhost:5173', 'ftp://example.com', 'http://localhost:5173/app'])(
    'rejects invalid FRONTEND_URL "%s"',
    (url) => {
      expect(() =>
        validateEnv({ FRONTEND_URL: url, DATABASE_URL: SAMPLE_DATABASE_URL }),
      ).toThrow(/FRONTEND_URL/);
    },
  );

  it.each(['development', 'production'])(
    'requires DATABASE_URL in %s',
    (nodeEnv) => {
      expect(() => validateEnv({ NODE_ENV: nodeEnv })).toThrow(
        /DATABASE_URL es obligatoria/,
      );
    },
  );

  it('allows a missing DATABASE_URL in test', () => {
    expect(validateEnv({ NODE_ENV: 'test' }).DATABASE_URL).toBeUndefined();
  });

  it('rejects a non-PostgreSQL DATABASE_URL without echoing its value', () => {
    const value = 'mysql://app_user:sample-password@db.example.com/app';
    let message = '';
    try {
      validateEnv({ DATABASE_URL: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL debe usar el protocolo/);
    expect(message).not.toContain('sample-password');
  });
});
