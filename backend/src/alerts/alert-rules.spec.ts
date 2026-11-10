import { decodeCursor, encodeCursor } from './alert-evaluation.service.js';
import {
  ALERT_SEVERITY,
  ALERT_TITLES,
  ALERT_TYPES,
  desiredAlert,
} from './alert-rules.js';

const ID = '7d1f8a9e-2b3c-4d5e-8f60-718293a4b5c6';

describe('alert rules', () => {
  it.each([
    ['obligation_occurrence', 'upcoming', 'obligation_due_soon', 'warning'],
    ['obligation_occurrence', 'due_today', 'obligation_due_soon', 'warning'],
    ['obligation_occurrence', 'overdue', 'obligation_overdue', 'critical'],
    ['rent_charge', 'upcoming', 'rent_charge_due_soon', 'warning'],
    ['rent_charge', 'overdue', 'rent_charge_overdue', 'critical'],
    ['contract', 'upcoming', 'contract_ending_soon', 'warning'],
    ['contract', 'overdue', 'contract_end_passed', 'critical'],
    ['hitl_request', 'pending', 'hitl_pending', 'warning'],
    ['hitl_request', 'due_soon', 'hitl_due_soon', 'critical'],
    ['hitl_request', 'overdue', 'hitl_overdue', 'critical'],
  ] as const)('%s %s → %s', (kind, condition, type, severity) => {
    expect(desiredAlert(kind, ID, '2026-11-18', condition)).toEqual({
      kind,
      resourceId: ID,
      type,
      severity,
      relevantDate: '2026-11-18',
      dedupKey: `${type}:${ID}:2026-11-18`,
    });
  });

  it.each([
    ['obligation_occurrence', 'scheduled'],
    ['obligation_occurrence', 'resolved'],
    ['rent_charge', 'resolved'],
    ['contract', 'scheduled'],
    ['hitl_request', 'resolved'],
  ] as const)('%s %s produces no alert', (kind, condition) => {
    expect(desiredAlert(kind, ID, '2026-11-18', condition)).toBeNull();
  });

  it('builds a different key when the stage or the date changes', () => {
    const soon = desiredAlert(
      'obligation_occurrence',
      ID,
      '2026-11-18',
      'upcoming',
    )!;
    const late = desiredAlert(
      'obligation_occurrence',
      ID,
      '2026-11-18',
      'overdue',
    )!;
    const moved = desiredAlert(
      'obligation_occurrence',
      ID,
      '2026-11-25',
      'upcoming',
    )!;
    expect(new Set([soon.dedupKey, late.dedupKey, moved.dedupKey]).size).toBe(
      3,
    );
  });

  it('defines a title and severity for every alert type', () => {
    for (const type of ALERT_TYPES) {
      expect(ALERT_TITLES[type]).toBeTruthy();
      expect(ALERT_SEVERITY[type]).toBeTruthy();
    }
  });

  describe('evaluation cursor', () => {
    it('round-trips', () => {
      const cursor = { date: '2026-11-18', phase: 2, after: ID };
      expect(decodeCursor(encodeCursor(cursor), '2026-11-18')).toEqual(cursor);
    });

    it('rejects a cursor from another day or a forged one', () => {
      const old = encodeCursor({ date: '2026-11-17', phase: 0, after: null });
      expect(() => decodeCursor(old, '2026-11-18')).toThrow(/cursor/);
      const forged = Buffer.from(`2026-11-18|9|${ID}`).toString('base64url');
      expect(() => decodeCursor(forged, '2026-11-18')).toThrow(/cursor/);
      const injected = Buffer.from(`2026-11-18|0|x' OR 1=1`).toString(
        'base64url',
      );
      expect(() => decodeCursor(injected, '2026-11-18')).toThrow(/cursor/);
    });
  });
});
