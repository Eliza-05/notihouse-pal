import {
  describeConnection,
  normalizeConnectionString,
} from './connection-string.js';

// Cadenas de ejemplo; no corresponden a ningún servidor real.
const base = 'postgresql://app_user:sample-password@db.example.com/app';

describe('normalizeConnectionString', () => {
  it.each(['require', 'prefer', 'verify-ca'])(
    'upgrades sslmode=%s to verify-full',
    (mode) => {
      const url = new URL(
        normalizeConnectionString(`${base}?sslmode=${mode}`, 'X'),
      );
      expect(url.searchParams.get('sslmode')).toBe('verify-full');
    },
  );

  it('keeps other parameters untouched', () => {
    const url = new URL(
      normalizeConnectionString(
        `${base}?sslmode=require&channel_binding=require`,
        'X',
      ),
    );
    expect(url.searchParams.get('channel_binding')).toBe('require');
    expect(url.pathname).toBe('/app');
  });

  it.each([undefined, '', '   '])('rejects a missing value (%s)', (value) => {
    expect(() => normalizeConnectionString(value, 'DATABASE_URL')).toThrow(
      'DATABASE_URL no está configurada',
    );
  });

  it('rejects malformed values without echoing them', () => {
    expect(() =>
      normalizeConnectionString('not a url sample-password', 'DATABASE_URL'),
    ).toThrow(/^DATABASE_URL no es una URL válida$/);
  });
});

describe('describeConnection', () => {
  it('omits user and password', () => {
    const description = describeConnection(base);
    expect(description).toBe('db.example.com/app');
    expect(description).not.toContain('sample-password');
    expect(description).not.toContain('app_user');
  });
});
