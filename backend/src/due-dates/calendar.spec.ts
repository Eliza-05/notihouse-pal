import {
  addDays,
  calendarDateIn,
  daysBetween,
  monthBounds,
} from './calendar.js';

const BOGOTA = 'America/Bogota';

describe('calendar dates', () => {
  describe('calendarDateIn (America/Bogota, UTC-5 sin horario de verano)', () => {
    it.each([
      // Antes de la medianoche de Bogotá ya es el día siguiente en UTC.
      ['2026-11-18T04:59:59Z', '2026-11-17'],
      ['2026-11-18T05:00:00Z', '2026-11-18'],
      ['2026-11-18T23:59:59Z', '2026-11-18'],
      // Cambio de año: en UTC ya es 2027, en Bogotá todavía 2026.
      ['2027-01-01T03:00:00Z', '2026-12-31'],
      ['2027-01-01T05:00:00Z', '2027-01-01'],
      // Año bisiesto.
      ['2028-02-29T12:00:00Z', '2028-02-29'],
      ['2028-03-01T04:00:00Z', '2028-02-29'],
    ])('%s → %s', (instant, expected) => {
      expect(calendarDateIn(new Date(instant), BOGOTA)).toBe(expected);
    });

    it('differs from UTC for the same instant', () => {
      const instant = new Date('2026-12-01T02:00:00Z');
      expect(calendarDateIn(instant, 'UTC')).toBe('2026-12-01');
      expect(calendarDateIn(instant, BOGOTA)).toBe('2026-11-30');
    });
  });

  describe('daysBetween', () => {
    it.each([
      ['2026-11-18', '2026-11-18', 0],
      ['2026-11-18', '2026-11-25', 7],
      ['2026-11-18', '2026-11-17', -1],
      ['2026-10-31', '2026-11-01', 1],
      ['2026-12-31', '2027-01-01', 1],
      ['2028-02-28', '2028-03-01', 2],
      ['2027-02-28', '2027-03-01', 1],
      ['2026-01-01', '2027-01-01', 365],
      ['2028-01-01', '2029-01-01', 366],
    ])('%s → %s = %d', (from, to, days) => {
      expect(daysBetween(from, to)).toBe(days);
    });
  });

  it('adds days across months and years', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-25', 7)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('computes month bounds, including December and February', () => {
    expect(monthBounds('2026-10-29')).toEqual({
      start: '2026-10-01',
      next: '2026-11-01',
    });
    expect(monthBounds('2026-12-15')).toEqual({
      start: '2026-12-01',
      next: '2027-01-01',
    });
    expect(monthBounds('2028-02-29')).toEqual({
      start: '2028-02-01',
      next: '2028-03-01',
    });
  });
});
