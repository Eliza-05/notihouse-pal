import { isCalendarDate, isMoneyAmount } from './validators.js';

describe('isCalendarDate', () => {
  it.each(['2026-01-01', '2024-02-29', '2026-12-31'])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each([
    '2026-02-29', // 2026 no es bisiesto
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-1-01',
    '2026/01/01',
    '2026-01-01T00:00:00Z',
    '',
    20260101,
    null,
  ])('rejects %s', (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });
});

describe('isMoneyAmount', () => {
  it.each(['0', '0.5', '145000', '145000.00', '999999999999.99'])(
    'accepts %s',
    (value) => {
      expect(isMoneyAmount(value)).toBe(true);
    },
  );

  it.each([
    '-1',
    '1.234',
    '01',
    '1e3',
    '1,000',
    ' 100',
    '1234567890123', // 13 dígitos enteros: excede numeric(14,2)
    '',
    145000, // number: se rechaza para no perder precisión
    null,
  ])('rejects %s', (value) => {
    expect(isMoneyAmount(value)).toBe(false);
  });
});
