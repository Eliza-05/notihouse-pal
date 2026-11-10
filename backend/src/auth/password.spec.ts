import {
  hashPassword,
  verifyAgainstDummyHash,
  verifyPassword,
} from './password.js';

describe('password hashing (Argon2id)', () => {
  it('produces an Argon2id hash with the OWASP minimum parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('uses a random salt (same password, different hashes)', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('right-password');
    await expect(verifyPassword(hash, 'right-password')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('treats a malformed hash as invalid instead of throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('always rejects when verifying against the dummy hash', async () => {
    await expect(verifyAgainstDummyHash('anything')).resolves.toBe(false);
  });
});
