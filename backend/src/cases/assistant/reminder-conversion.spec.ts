import { reminderDaysBeforeFromAbsoluteDay } from './reminder-conversion.js';

describe('reminderDaysBeforeFromAbsoluteDay (§19.6)', () => {
  it('"vence el 15, avísame el 7" → 8 días antes (ejemplo de la guía)', () => {
    expect(reminderDaysBeforeFromAbsoluteDay(15, 7)).toBe(8);
  });

  it('"vence el 15, avísame el 15" → 0 (el mismo día)', () => {
    expect(reminderDaysBeforeFromAbsoluteDay(15, 15)).toBe(0);
  });

  it('wraps into the previous month when the reminder day is after the due day', () => {
    expect(reminderDaysBeforeFromAbsoluteDay(5, 28)).toBe(8);
  });
});
