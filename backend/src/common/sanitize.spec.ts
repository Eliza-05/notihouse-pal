import { sanitizeErrorMessage } from './sanitize.js';

describe('sanitizeErrorMessage', () => {
  it.each([
    ['Bearer abc.def.ghi rejected', 'abc.def.ghi'],
    ['connect postgresql://user:hunter2@db.example.com/x failed', 'hunter2'],
    ['password=hunter2 invalid', 'hunter2'],
    ['{"api_key": "sk-123456"}', 'sk-123456'],
    ['token: zzz-secret-value', 'zzz-secret-value'],
    ['mail to tenant@example.com bounced', 'tenant@example.com'],
    [`key ${'A'.repeat(40)} leaked`, 'A'.repeat(40)],
  ])('redacts secrets in "%s"', (input, secret) => {
    const output = sanitizeErrorMessage(input);
    expect(output).not.toContain(secret);
    expect(output).toContain('***');
  });

  it('keeps ordinary messages readable', () => {
    expect(sanitizeErrorMessage('Gmail API timeout after 30s')).toBe(
      'Gmail API timeout after 30s',
    );
  });

  it('removes control characters and truncates to 500 characters', () => {
    expect(sanitizeErrorMessage('line1\nline2\t\u0007end')).toBe(
      'line1 line2 end',
    );
    const long = sanitizeErrorMessage('x '.repeat(600));
    expect(long.length).toBe(500);
    expect(long.endsWith('…')).toBe(true);
  });
});
