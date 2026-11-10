import { describeCredentials } from './demo-credentials-check.js';
import { parseKillSwitchArgs } from './kill-switch.js';

describe('demo credentials inspector', () => {
  const secret = 'Zq9-secreto-QW_7';
  const file = [
    '# NotiHouse-Pal — credenciales',
    '# Contraseña temporal compartida solo para la demostración',
    '',
    `Daniel Rojas\tdaniel.rojas@demo.test\t${secret}`,
    `Laura Gómez\tlaura.gomez@demo.test\t${secret}`,
    'línea rota sin tabuladores',
  ].join('\n');

  it('never returns the password, in any field (whitelist output)', () => {
    const report = describeCredentials(file);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain('secreto');
    expect(report.accounts).toEqual([
      { name: 'Daniel Rojas', email: 'da***@d***.test', passwordLength: 16 },
      { name: 'Laura Gómez', email: 'la***@d***.test', passwordLength: 16 },
    ]);
  });

  it('detects a shared password and malformed lines', () => {
    const report = describeCredentials(file);
    expect(report.distinctPasswords).toBe(1);
    expect(report.malformedLines).toBe(1);
  });
});

describe('kill switch operator CLI arguments', () => {
  it('parses status, activate and resume', () => {
    expect(parseKillSwitchArgs(['status'])).toEqual({ command: 'status' });
    expect(
      parseKillSwitchArgs([
        'activate',
        '--scope',
        'document_processing',
        '--operator',
        'Elizabeth',
        '--reason',
        'Respuestas manipuladas',
      ]),
    ).toEqual({
      command: 'activate',
      scope: 'document_processing',
      operator: 'Elizabeth',
      reason: 'Respuestas manipuladas',
    });
    expect(
      parseKillSwitchArgs([
        'resume',
        '--scope',
        'global',
        '--operator',
        'Elizabeth',
        '--reason',
        'Prompt corregido',
        '--test-evidence',
        '3 casos de regresión OK',
      ]),
    ).toMatchObject({
      command: 'resume',
      testEvidence: '3 casos de regresión OK',
    });
  });

  it('refuses a resume without test evidence, an unknown scope or a bare command', () => {
    expect(() =>
      parseKillSwitchArgs([
        'resume',
        '--scope',
        'global',
        '--operator',
        'Elizabeth',
        '--reason',
        'Prompt corregido',
      ]),
    ).toThrow(/test-evidence/);
    expect(() =>
      parseKillSwitchArgs([
        'activate',
        '--scope',
        'todo',
        '--operator',
        'x y z',
        '--reason',
        'abc',
      ]),
    ).toThrow(/--scope/);
    expect(() => parseKillSwitchArgs(['delete'])).toThrow(/Uso/);
  });
});
