import { computeCycle, currentCycleIndex } from './cycle.js';

describe('recurrence cycles (pure, §19.4)', () => {
  describe('currentCycleIndex', () => {
    it('never goes before the anchor (first cycle, D1 "nunca hacia atrás")', () => {
      expect(
        currentCycleIndex(
          { year: 2026, month: 11 },
          1,
          { year: 2026, month: 3 },
        ),
      ).toBe(0);
    });

    it('finds the monthly cycle containing today', () => {
      expect(
        currentCycleIndex(
          { year: 2026, month: 1 },
          1,
          { year: 2026, month: 11 },
        ),
      ).toBe(10);
    });

    it('finds the quarterly cycle containing today', () => {
      // Ancla en enero: ciclos [ene-mar], [abr-jun], [jul-sep], [oct-dic].
      expect(
        currentCycleIndex(
          { year: 2026, month: 1 },
          3,
          { year: 2026, month: 8 },
        ),
      ).toBe(2);
    });

    it('does not fabricate past cycles after a long outage (D3): always relative to today', () => {
      // Apagado desde enero, el barrido corre en noviembre: el ciclo actual es
      // el de noviembre, sin rellenar los diez meses intermedios.
      const idx = currentCycleIndex(
        { year: 2026, month: 1 },
        1,
        { year: 2026, month: 11 },
      );
      expect(idx).toBe(10);
    });
  });

  describe('computeCycle', () => {
    it('builds a monthly cycle with periodStart/periodEnd/dueDate', () => {
      expect(
        computeCycle({
          anchor: { year: 2026, month: 1 },
          frequencyMonths: 1,
          cycleIndex: 10,
          dueDay: 18,
        }),
      ).toEqual({
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        dueDate: '2026-11-18',
      });
    });

    it('clamps day 31 to the last day of a short month (D1)', () => {
      expect(
        computeCycle({
          anchor: { year: 2027, month: 2 },
          frequencyMonths: 1,
          cycleIndex: 0,
          dueDay: 31,
        }),
      ).toMatchObject({ periodStart: '2027-02-01', dueDate: '2027-02-28' });

      expect(
        computeCycle({
          anchor: { year: 2028, month: 2 },
          frequencyMonths: 1,
          cycleIndex: 0,
          dueDay: 31,
        }),
      ).toMatchObject({ dueDate: '2028-02-29' });

      expect(
        computeCycle({
          anchor: { year: 2026, month: 4 },
          frequencyMonths: 1,
          cycleIndex: 0,
          dueDay: 31,
        }),
      ).toMatchObject({ dueDate: '2026-04-30' });
    });

    it('spans several months for bimonthly/quarterly/semiannual/annual frequencies', () => {
      expect(
        computeCycle({
          anchor: { year: 2026, month: 1 },
          frequencyMonths: 3,
          cycleIndex: 1,
          dueDay: 10,
        }),
      ).toEqual({
        periodStart: '2026-04-01',
        periodEnd: '2026-06-30',
        dueDate: '2026-04-10',
      });

      expect(
        computeCycle({
          anchor: { year: 2026, month: 1 },
          frequencyMonths: 12,
          cycleIndex: 0,
          dueDay: 5,
        }),
      ).toEqual({
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        dueDate: '2026-01-05',
      });
    });

    it('never invents a due date when the definition has none', () => {
      expect(
        computeCycle({
          anchor: { year: 2026, month: 11 },
          frequencyMonths: 1,
          cycleIndex: 0,
          dueDay: null,
        }).dueDate,
      ).toBeNull();
    });

    it('clamps periodStart to a lower bound (rent charges within validity)', () => {
      expect(
        computeCycle({
          anchor: { year: 2026, month: 11 },
          frequencyMonths: 1,
          cycleIndex: 0,
          dueDay: 5,
          lowerBound: '2026-11-15',
        }),
      ).toMatchObject({ periodStart: '2026-11-15', periodEnd: '2026-11-30' });

      // El límite inferior no se aplica si el ciclo ya empieza después.
      expect(
        computeCycle({
          anchor: { year: 2026, month: 11 },
          frequencyMonths: 1,
          cycleIndex: 1,
          dueDay: 5,
          lowerBound: '2026-11-15',
        }),
      ).toMatchObject({ periodStart: '2026-12-01' });
    });
  });
});
