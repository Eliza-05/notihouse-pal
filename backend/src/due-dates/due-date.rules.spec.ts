import { addDays } from './calendar.js';
import {
  attentionPriority,
  type DueDateRules,
  evaluateContract,
  evaluateHitl,
  evaluateOccurrence,
  evaluateOccurrenceAlert,
  evaluateRentCharge,
} from './due-date.rules.js';

const RULES: DueDateRules = {
  timeZone: 'America/Bogota',
  obligationDays: 7,
  rentChargeDays: 7,
  contractDays: 30,
  hitlSoonHours: 6,
};
const TODAY = '2026-11-18';
const addDaysToToday = (days: number) => addDays(TODAY, days);

describe('due-date rules', () => {
  describe('obligation occurrences', () => {
    const occ = (dueDate: string, status = 'pending', reminderDaysBefore = 3) =>
      evaluateOccurrence({ dueDate, status, reminderDaysBefore }, RULES, TODAY);

    it.each([
      ['more than 7 days ahead', '2026-11-26', 'scheduled', 8, 0, false],
      ['exactly at the threshold', '2026-11-25', 'upcoming', 7, 0, true],
      ['within the threshold', '2026-11-20', 'upcoming', 2, 0, true],
      ['due today', '2026-11-18', 'due_today', 0, 0, true],
      ['due yesterday', '2026-11-17', 'overdue', -1, 1, true],
      ['due several days ago', '2026-11-08', 'overdue', -10, 10, true],
    ])(
      '%s',
      (_label, dueDate, condition, daysUntil, daysOverdue, attention) => {
        expect(occ(dueDate)).toEqual({
          condition,
          daysUntil,
          daysOverdue,
          windowDays: 7,
          requiresAttention: attention,
        });
      },
    );

    it('treats a stored "overdue" status as still open', () => {
      expect(occ('2026-11-10', 'overdue').condition).toBe('overdue');
    });

    it.each(['paid', 'attended', 'cancelled'])(
      'never asks to pay a %s period, even if its date passed',
      (status) => {
        const result = occ('2026-11-01', status);
        expect(result).toMatchObject({
          condition: 'resolved',
          daysOverdue: 0,
          requiresAttention: false,
        });
      },
    );

    it('uses reminder_days_before when it is larger than the MVP threshold', () => {
      expect(occ('2026-11-30', 'pending', 15)).toMatchObject({
        condition: 'upcoming',
        windowDays: 15,
      });
      expect(occ('2026-11-30', 'pending', 3).condition).toBe('scheduled');
    });

    it('follows a changed due date deterministically', () => {
      expect(occ('2026-11-17').condition).toBe('overdue');
      expect(occ('2026-11-28').condition).toBe('scheduled');
    });

    it('handles month and year boundaries', () => {
      expect(
        evaluateOccurrence(
          { dueDate: '2026-12-02', status: 'pending', reminderDaysBefore: 3 },
          RULES,
          '2026-11-30',
        ),
      ).toMatchObject({ condition: 'upcoming', daysUntil: 2 });
      expect(
        evaluateOccurrence(
          { dueDate: '2027-01-03', status: 'pending', reminderDaysBefore: 3 },
          RULES,
          '2026-12-30',
        ),
      ).toMatchObject({ condition: 'upcoming', daysUntil: 4 });
      expect(
        evaluateOccurrence(
          { dueDate: '2026-12-31', status: 'pending', reminderDaysBefore: 3 },
          RULES,
          '2027-01-01',
        ),
      ).toMatchObject({ condition: 'overdue', daysOverdue: 1 });
    });

    it('handles February 29 in a leap year and day 31 in short months', () => {
      expect(
        evaluateOccurrence(
          { dueDate: '2028-02-29', status: 'pending', reminderDaysBefore: 0 },
          RULES,
          '2028-02-29',
        ).condition,
      ).toBe('due_today');
      expect(
        evaluateOccurrence(
          { dueDate: '2028-03-01', status: 'pending', reminderDaysBefore: 0 },
          RULES,
          '2028-02-28',
        ).daysUntil,
      ).toBe(2);
      // Un período "día 31" registrado como 30 de noviembre vence el 30.
      expect(occ('2026-11-30').daysUntil).toBe(12);
    });

    it('returns the same result for the same input', () => {
      expect(occ('2026-11-20')).toEqual(occ('2026-11-20'));
    });
  });

  /**
   * D6 (aprobada 7-nov-2026): la alerta `obligation_due_soon` usa una
   * ventana PERSONALIZADA (solo `reminderDaysBefore`, nunca `max(7, …)`
   * como la ventana general de `evaluateOccurrence`, que no cambia).
   * `overdue` no depende de la ventana: es igual en ambas.
   */
  describe('obligation occurrence alert window (D6)', () => {
    const alert = (
      dueDate: string,
      reminderDaysBefore: number,
      status = 'pending',
    ) => evaluateOccurrenceAlert({ dueDate, status, reminderDaysBefore }, TODAY);

    it.each([
      // reminderDaysBefore, daysUntil, condition esperado.
      [0, 1, 'scheduled'],
      [0, 0, 'due_today'],
      [3, 4, 'scheduled'],
      [3, 3, 'upcoming'],
      [3, 0, 'due_today'],
      [7, 8, 'scheduled'],
      [7, 7, 'upcoming'],
      [8, 8, 'upcoming'],
      [8, 9, 'scheduled'],
      [60, 60, 'upcoming'],
      [60, 61, 'scheduled'],
    ])(
      'reminderDaysBefore=%d, daysUntil=%d → %s (límite exacto: día −N avisa, día −N−1 no)',
      (reminderDaysBefore, daysUntil, condition) => {
        const dueDate = addDaysToToday(daysUntil);
        expect(alert(dueDate, reminderDaysBefore).condition).toBe(condition);
      },
    );

    it('with reminderDaysBefore=3, emits at day 12 (not day 8) for a due date on day 15', () => {
      // Ejemplo de aceptación de la guía: hoy 2026-11-12, vence 2026-11-15.
      expect(
        evaluateOccurrenceAlert(
          { dueDate: '2026-11-15', status: 'pending', reminderDaysBefore: 3 },
          '2026-11-08',
        ).condition,
      ).toBe('scheduled');
      expect(
        evaluateOccurrenceAlert(
          { dueDate: '2026-11-15', status: 'pending', reminderDaysBefore: 3 },
          '2026-11-12',
        ).condition,
      ).toBe('upcoming');
    });

    it('with reminderDaysBefore=0, emits exactly on the due date', () => {
      expect(
        evaluateOccurrenceAlert(
          { dueDate: '2026-11-15', status: 'pending', reminderDaysBefore: 0 },
          '2026-11-14',
        ).condition,
      ).toBe('scheduled');
      expect(
        evaluateOccurrenceAlert(
          { dueDate: '2026-11-15', status: 'pending', reminderDaysBefore: 0 },
          '2026-11-15',
        ).condition,
      ).toBe('due_today');
    });

    it.each(['paid', 'attended', 'cancelled'])(
      'never alerts a %s period, even within the personalized window',
      (status) => {
        expect(alert(TODAY, 60, status).condition).toBe('resolved');
      },
    );

    it('overdue does not depend on the window: identical to the general evaluation', () => {
      const row = { dueDate: '2026-11-01', status: 'pending', reminderDaysBefore: 3 };
      expect(evaluateOccurrenceAlert(row, TODAY).condition).toBe('overdue');
      expect(evaluateOccurrence(row, RULES, TODAY).condition).toBe('overdue');
    });

    it('a window wider than 7 (reminderDaysBefore=60) agrees with the general evaluation', () => {
      // Cuando reminderDaysBefore ≥ 7, la ventana general (max(7, N) = N) y
      // la personalizada (N) coinciden: no hay diferencia que observar.
      const row = {
        dueDate: '2026-11-30',
        status: 'pending',
        reminderDaysBefore: 60,
      };
      expect(evaluateOccurrence(row, RULES, TODAY).condition).toBe('upcoming');
      expect(evaluateOccurrenceAlert(row, TODAY).condition).toBe('upcoming');
    });
  });

  describe('rent charges', () => {
    const charge = (dueDate: string, status = 'expected') =>
      evaluateRentCharge({ dueDate, status }, RULES, TODAY);

    it.each([
      ['future', '2026-12-05', 'scheduled'],
      ['upcoming', '2026-11-22', 'upcoming'],
      ['due today', '2026-11-18', 'due_today'],
      ['overdue', '2026-11-05', 'overdue'],
    ])('%s charge', (_label, dueDate, condition) => {
      expect(charge(dueDate).condition).toBe(condition);
    });

    it.each(['expected', 'pending', 'overdue'])(
      '%s counts as still pending',
      (status) => {
        expect(charge('2026-11-05', status).requiresAttention).toBe(true);
      },
    );

    it.each(['received', 'cancelled'])(
      'a %s charge is never pending income',
      (status) => {
        expect(charge('2026-11-05', status)).toMatchObject({
          condition: 'resolved',
          requiresAttention: false,
        });
      },
    );

    it('ignores the rent amount (a new canon does not alter old charges)', () => {
      const withAmount = {
        dueDate: '2026-11-22',
        status: 'expected',
        expectedAmount: '9.99',
      };
      expect(evaluateRentCharge(withAmount, RULES, TODAY)).toEqual(
        charge('2026-11-22'),
      );
    });
  });

  describe('contracts', () => {
    const contract = (
      endsOn: string,
      status = 'active',
      noticePeriodDays: number | null = null,
      today = TODAY,
    ) => evaluateContract({ endsOn, status, noticePeriodDays }, RULES, today);

    it.each([
      ['far away', '2027-06-30', 'scheduled'],
      ['within 30 days', '2026-12-15', 'upcoming'],
      ['ending today', '2026-11-18', 'due_today'],
      ['end date already passed', '2026-11-01', 'overdue'],
    ])('%s', (_label, endsOn, condition) => {
      expect(contract(endsOn).condition).toBe(condition);
    });

    it.each(['terminated', 'expired'])(
      'an explicitly %s contract needs no action',
      (status) => {
        expect(contract('2026-11-01', status).condition).toBe('resolved');
      },
    );

    it('widens the window to the agreed notice period', () => {
      expect(contract('2027-01-30', 'active', 90)).toMatchObject({
        condition: 'upcoming',
        windowDays: 90,
      });
      expect(contract('2027-01-30', 'active', 10).condition).toBe('scheduled');
    });

    it('works across months and years', () => {
      expect(
        contract('2027-01-10', 'active', null, '2026-12-20'),
      ).toMatchObject({
        condition: 'upcoming',
        daysUntil: 21,
      });
    });
  });

  describe('HITL reviews', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const hitl = (dueAt: string, status = 'pending') =>
      evaluateHitl({ dueAt: new Date(dueAt), status }, RULES, now);

    it.each([
      ['2026-11-19T10:00:00Z', 'pending'],
      ['2026-11-18T18:00:00Z', 'due_soon'],
      ['2026-11-18T12:00:00Z', 'overdue'],
      ['2026-11-18T11:00:00Z', 'overdue'],
    ])('due at %s → %s', (dueAt, condition) => {
      expect(hitl(dueAt).condition).toBe(condition);
    });

    it.each(['approved', 'rejected', 'expired', 'cancelled'])(
      'a %s review is resolved',
      (status) => {
        expect(hitl('2026-11-18T13:00:00Z', status).condition).toBe('resolved');
      },
    );
  });

  describe('attention priority', () => {
    it('orders HITL urgency, overdue, today, upcoming', () => {
      expect(attentionPriority('hitl_request', 'due_soon')).toBe(1);
      expect(attentionPriority('hitl_request', 'overdue')).toBe(1);
      expect(attentionPriority('obligation_occurrence', 'overdue')).toBe(2);
      expect(attentionPriority('rent_charge', 'overdue')).toBe(2);
      expect(attentionPriority('contract', 'overdue')).toBe(2);
      expect(attentionPriority('rent_charge', 'due_today')).toBe(3);
      expect(attentionPriority('contract', 'upcoming')).toBe(4);
      expect(attentionPriority('hitl_request', 'pending')).toBe(4);
    });

    it('excludes scheduled and resolved items', () => {
      expect(
        attentionPriority('obligation_occurrence', 'scheduled'),
      ).toBeNull();
      expect(attentionPriority('contract', 'resolved')).toBeNull();
      expect(attentionPriority('hitl_request', 'resolved')).toBeNull();
    });
  });
});
