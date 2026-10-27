import {
  CLAIM_TOKEN_PATTERN,
  claimFingerprint,
  matchClaim,
  newClaimToken,
  retryDelaySeconds,
  workerOf,
} from './job-claims.js';

describe('job claims', () => {
  it('generates distinct high-entropy tokens', () => {
    const a = newClaimToken();
    const b = newClaimToken();
    expect(a).toMatch(CLAIM_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });

  it('stores only a fingerprint, never the token', () => {
    const token = newClaimToken();
    const fingerprint = claimFingerprint('worker-1', token);
    expect(fingerprint).not.toContain(token);
    expect(fingerprint).toMatch(/^worker-1#[0-9a-f]{64}$/);
    expect(workerOf(fingerprint)).toBe('worker-1');
  });

  it('matches only the token of the current claim', () => {
    const old = newClaimToken();
    const current = newClaimToken();
    const fingerprint = claimFingerprint('worker-1', current);
    expect(matchClaim(fingerprint, current)).toBe('worker-1');
    // Respuesta tardía de una reclamación anterior del mismo worker.
    expect(matchClaim(fingerprint, old)).toBeNull();
    expect(matchClaim(fingerprint, '')).toBeNull();
  });

  it.each([null, '', 'worker-1', '#abc', 'worker-1#zz', 'worker-1#abcd'])(
    'rejects malformed lockedBy %s',
    (lockedBy) => {
      expect(matchClaim(lockedBy, newClaimToken())).toBeNull();
    },
  );

  it('backs off exponentially with a one-hour cap', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([30, 60, 120, 240]);
    expect(retryDelaySeconds(20)).toBe(3600);
  });
});
