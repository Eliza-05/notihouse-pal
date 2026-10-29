import type { TestingModuleBuilder } from '@nestjs/testing';
import { addDays, calendarDateIn } from '../../src/due-dates/calendar.js';
import { CLOCK, type Clock } from '../../src/due-dates/clock.js';

export interface TestClock extends Clock {
  current: Date;
  /** Día civil actual en America/Bogota. */
  today(): string;
  /** Fecha de calendario relativa a hoy (`d(-1)` = ayer). */
  d(offset: number): string;
  advanceDays(days: number): void;
}

/**
 * Reloj fijo para el motor de vencimientos. Se fija al instante en que empieza
 * la suite (las revisiones HITL usan `now()` de PostgreSQL para su plazo de
 * 24 h); a partir de ahí solo avanza cuando la prueba lo pide.
 */
export function createTestClock(start = new Date()): TestClock {
  const clock: TestClock = {
    current: start,
    now: () => clock.current,
    today: () => calendarDateIn(clock.current, 'America/Bogota'),
    d: (offset) => addDays(clock.today(), offset),
    advanceDays: (days) => {
      clock.current = new Date(clock.current.getTime() + days * 86_400_000);
    },
  };
  return clock;
}

export const withClock =
  (clock: Clock) =>
  (builder: TestingModuleBuilder): TestingModuleBuilder =>
    builder.overrideProvider(CLOCK).useValue(clock);
