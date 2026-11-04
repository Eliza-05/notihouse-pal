import {
  assertFacts,
  assertSafeConfiguration,
  ENABLE_VALUE,
  OWNER_ROLE,
  type TargetFacts,
  UnsafeTargetError,
} from './target-guard.js';

const LOCAL = 'postgresql://u:p@127.0.0.1:55432/notihouse_concurrency';
const enabled = { CONCURRENCY_TEST_ENABLED: ENABLE_VALUE };

describe('assertSafeConfiguration', () => {
  it('accepts only the exact disposable target', () => {
    expect(() => assertSafeConfiguration(enabled, LOCAL, 'X')).not.toThrow();
  });

  it.each<[string, NodeJS.ProcessEnv, string | undefined]>([
    ['disabled', {}, LOCAL],
    ['wrong enable value', { CONCURRENCY_TEST_ENABLED: 'true' }, LOCAL],
    ['missing url', enabled, undefined],
    ['malformed url', enabled, 'not a url'],
    [
      'neon host',
      enabled,
      'postgresql://u:p@ep-x.neon.tech/notihouse_concurrency',
    ],
    [
      'remote host',
      enabled,
      'postgresql://u:p@10.0.0.5:55432/notihouse_concurrency',
    ],
    [
      'default port',
      enabled,
      'postgresql://u:p@127.0.0.1:5432/notihouse_concurrency',
    ],
    ['other database', enabled, 'postgresql://u:p@127.0.0.1:55432/neondb'],
    ['same as DATABASE_URL', { ...enabled, DATABASE_URL: LOCAL }, LOCAL],
    ['same as direct url', { ...enabled, DATABASE_URL_DIRECT: LOCAL }, LOCAL],
    ['production', { ...enabled, NODE_ENV: 'production' }, LOCAL],
    ['render', { ...enabled, RENDER: 'true' }, LOCAL],
    ['ci', { ...enabled, CI: 'true' }, LOCAL],
  ])('refuses: %s', (_name, env, url) => {
    expect(() => assertSafeConfiguration(env, url, 'X')).toThrow(
      UnsafeTargetError,
    );
  });

  it('never includes credentials in the message', () => {
    expect(() =>
      assertSafeConfiguration(
        enabled,
        'postgresql://user:SECRET@host.neon.tech/db',
        'X',
      ),
    ).toThrow(expect.not.stringContaining('SECRET') as unknown as string);
  });
});

describe('assertFacts', () => {
  const facts: TargetFacts = {
    database: 'notihouse_concurrency',
    role: OWNER_ROLE,
    versionNum: 180006,
    neonSetting: null,
    comment: 'notihouse-concurrency-disposable:abc',
    systemIdentifier: '1',
  };
  const expected = { role: OWNER_ROLE, marker: 'abc', systemIdentifier: '1' };

  it('accepts the expected server', () => {
    expect(() => assertFacts(facts, expected)).not.toThrow();
  });

  it.each<[string, Partial<TargetFacts>]>([
    ['other database', { database: 'neondb' }],
    ['other major version', { versionNum: 170005 }],
    ['other role', { role: 'neondb_owner' }],
    ['neon settings', { neonSetting: 'tenant' }],
    ['no marker', { comment: null }],
    ['foreign marker', { comment: 'notihouse-concurrency-disposable:x' }],
    ['other server', { systemIdentifier: '2' }],
  ])('refuses: %s', (_name, patch) => {
    expect(() => assertFacts({ ...facts, ...patch }, expected)).toThrow(
      UnsafeTargetError,
    );
  });
});
