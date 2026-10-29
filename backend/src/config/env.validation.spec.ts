import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UPLOAD_LIMITS, validateEnv } from './env.validation.js';

// Valores de ejemplo para pruebas; no corresponden a ningún servidor ni secreto real.
const SAMPLE_DATABASE_URL =
  'postgresql://app_user:sample-password@db.example.com/app?sslmode=require';
const SAMPLE_JWT_SECRET = randomBytes(32).toString('base64url');
const SAMPLE_SERVICE_TOKEN = randomBytes(32).toString('base64url');
const LOCAL_STORAGE_DEFAULTS = {
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_PATH: resolve('.local/storage'),
  STORAGE_UPLOAD_TMP_PATH: resolve(join(tmpdir(), 'notihouse-uploads')),
  STORAGE_MAX_PDF_BYTES: 10 * 1024 * 1024,
  STORAGE_MAX_AUDIO_BYTES: 25 * 1024 * 1024,
  STORAGE_S3_FORCE_PATH_STYLE: false,
};
// Configuración S3 ficticia: nunca se usa para conectarse.
const SAMPLE_S3 = {
  STORAGE_DRIVER: 's3',
  STORAGE_S3_BUCKET: 'notihouse-private-example',
  STORAGE_S3_REGION: 'us-east-2',
};
const REQUIRED = {
  DATABASE_URL: SAMPLE_DATABASE_URL,
  JWT_SECRET: SAMPLE_JWT_SECRET,
};

describe('validateEnv', () => {
  it('applies development defaults when optional variables are missing', () => {
    expect(validateEnv(REQUIRED)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      FRONTEND_URL: 'http://localhost:5173',
      ...REQUIRED,
      ...LOCAL_STORAGE_DEFAULTS,
    });
  });

  it('parses valid values', () => {
    expect(
      validateEnv({
        ...REQUIRED,
        NODE_ENV: 'production',
        PORT: '10000',
        FRONTEND_URL: 'https://app.example.com',
        N8N_SERVICE_TOKEN: SAMPLE_SERVICE_TOKEN,
        ...SAMPLE_S3,
      }),
    ).toMatchObject({
      NODE_ENV: 'production',
      PORT: 10000,
      FRONTEND_URL: 'https://app.example.com',
      ...REQUIRED,
      N8N_SERVICE_TOKEN: SAMPLE_SERVICE_TOKEN,
      ...SAMPLE_S3,
    });
  });

  it.each(['abc', '0', '65536', '-1', '3000.5', '30 00'])(
    'rejects invalid PORT "%s"',
    (port) => {
      expect(() => validateEnv({ ...REQUIRED, PORT: port })).toThrow(
        /PORT debe ser/,
      );
    },
  );

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...REQUIRED, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it.each(['localhost:5173', 'ftp://example.com', 'http://localhost:5173/app'])(
    'rejects invalid FRONTEND_URL "%s"',
    (url) => {
      expect(() => validateEnv({ ...REQUIRED, FRONTEND_URL: url })).toThrow(
        /FRONTEND_URL/,
      );
    },
  );

  it.each(['development', 'production'])(
    'requires DATABASE_URL in %s',
    (nodeEnv) => {
      expect(() =>
        validateEnv({ NODE_ENV: nodeEnv, JWT_SECRET: SAMPLE_JWT_SECRET }),
      ).toThrow(/DATABASE_URL es obligatoria/);
    },
  );

  it('allows missing DATABASE_URL and JWT_SECRET in test', () => {
    const env = validateEnv({ NODE_ENV: 'test' });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('rejects a non-PostgreSQL DATABASE_URL without echoing its value', () => {
    const value = 'mysql://app_user:sample-password@db.example.com/app';
    let message = '';
    try {
      validateEnv({ ...REQUIRED, DATABASE_URL: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL debe usar el protocolo/);
    expect(message).not.toContain('sample-password');
  });

  it.each(['development', 'production'])('requires JWT_SECRET in %s', (env) => {
    expect(() =>
      validateEnv({ NODE_ENV: env, DATABASE_URL: SAMPLE_DATABASE_URL }),
    ).toThrow(/JWT_SECRET es obligatoria/);
  });

  it.each([
    ['too short', randomBytes(16).toString('base64url')],
    ['placeholder', `changeme-${randomBytes(32).toString('base64url')}`],
    ['low entropy', 'a'.repeat(64)],
  ])('rejects an insecure JWT_SECRET (%s) without echoing it', (_c, secret) => {
    let message = '';
    try {
      validateEnv({ ...REQUIRED, JWT_SECRET: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/JWT_SECRET es insegura/);
    expect(message).not.toContain(secret);
  });

  it('requires N8N_SERVICE_TOKEN only in production', () => {
    expect(() =>
      validateEnv({ ...REQUIRED, ...SAMPLE_S3, NODE_ENV: 'production' }),
    ).toThrow(/N8N_SERVICE_TOKEN es obligatoria en producción/);
    expect(validateEnv(REQUIRED).N8N_SERVICE_TOKEN).toBeUndefined();
  });

  it.each([
    ['too short', randomBytes(16).toString('base64url')],
    ['placeholder', `secret-${randomBytes(32).toString('base64url')}`],
    ['low entropy', 'b'.repeat(64)],
  ])(
    'rejects an insecure N8N_SERVICE_TOKEN (%s) without echoing it',
    (_c, token) => {
      let message = '';
      try {
        validateEnv({ ...REQUIRED, N8N_SERVICE_TOKEN: token });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/N8N_SERVICE_TOKEN es insegura/);
      expect(message).not.toContain(token);
    },
  );

  it('rejects reusing JWT_SECRET as the service token', () => {
    expect(() =>
      validateEnv({ ...REQUIRED, N8N_SERVICE_TOKEN: SAMPLE_JWT_SECRET }),
    ).toThrow(/no puede ser igual a JWT_SECRET/);
  });

  describe('storage', () => {
    const PRODUCTION = {
      ...REQUIRED,
      NODE_ENV: 'production',
      N8N_SERVICE_TOKEN: SAMPLE_SERVICE_TOKEN,
    };

    it('never accepts the ephemeral local disk in production', () => {
      expect(() => validateEnv(PRODUCTION)).toThrow(
        /STORAGE_DRIVER es obligatoria en producción/,
      );
      expect(() =>
        validateEnv({ ...PRODUCTION, STORAGE_DRIVER: 'local' }),
      ).toThrow(/no está permitido en producción/);
      expect(validateEnv({ ...PRODUCTION, ...SAMPLE_S3 }).STORAGE_DRIVER).toBe(
        's3',
      );
    });

    it('requires bucket and region for s3, and both keys or none', () => {
      expect(() => validateEnv({ ...REQUIRED, STORAGE_DRIVER: 's3' })).toThrow(
        /STORAGE_S3_BUCKET es obligatoria[\s\S]*STORAGE_S3_REGION es obligatoria/,
      );
      const secret = randomBytes(30).toString('base64url');
      let message = '';
      try {
        validateEnv({
          ...REQUIRED,
          ...SAMPLE_S3,
          STORAGE_S3_SECRET_ACCESS_KEY: secret,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/deben definirse juntas/);
      expect(message).not.toContain(secret);
    });

    it.each([
      ['plain http in production', 'http://storage.example.com', 'production'],
      [
        'credentials in URL',
        'https://user:pass@storage.example.com',
        'development',
      ],
      ['not a URL', 'storage', 'development'],
    ])('rejects an unsafe S3 endpoint (%s)', (_c, endpoint, env) => {
      expect(() =>
        validateEnv({
          ...REQUIRED,
          ...SAMPLE_S3,
          N8N_SERVICE_TOKEN: SAMPLE_SERVICE_TOKEN,
          NODE_ENV: env,
          STORAGE_S3_ENDPOINT: endpoint,
        }),
      ).toThrow(/STORAGE_S3_ENDPOINT debe ser una URL/);
    });

    it.each([
      ['STORAGE_MAX_PDF_BYTES', '0'],
      ['STORAGE_MAX_PDF_BYTES', String(UPLOAD_LIMITS.pdf.max + 1)],
      ['STORAGE_MAX_AUDIO_BYTES', '1.5'],
      ['STORAGE_DRIVER', 'ftp'],
      ['STORAGE_S3_FORCE_PATH_STYLE', 'yes'],
    ])('rejects %s=%s', (key, value) => {
      expect(() => validateEnv({ ...REQUIRED, [key]: value })).toThrow(key);
    });

    it('resolves a relative local path to an absolute one', () => {
      expect(
        validateEnv({ ...REQUIRED, STORAGE_LOCAL_PATH: 'tmp/files' })
          .STORAGE_LOCAL_PATH,
      ).toBe(resolve('tmp/files'));
    });
  });
});
