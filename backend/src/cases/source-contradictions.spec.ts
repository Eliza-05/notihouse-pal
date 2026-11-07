import { contradicts, factsOf, sameProvider } from './source-contradictions.js';

describe('E12 source contradictions', () => {
  const gmail = factsOf({
    action: 'create_obligation_with_occurrence',
    data: {
      obligation: { providerName: 'Energía de Prueba S.A. E.S.P.' },
      occurrence: {
        periodStart: '2026-09-15',
        periodEnd: '2026-10-14',
        dueDate: '2026-10-17',
        amount: '188420.00',
      },
    },
  })!;
  const voice = factsOf({
    interpretacion: {
      providerName: 'Energía de prueba',
      amount: '180000.00',
      dueDate: null,
    },
    camposProblematicos: ['fecha de vencimiento'],
  })!;

  it('extracts comparable facts from applicable and manual-review proposals', () => {
    expect(gmail).toEqual({
      obligationId: null,
      providerName: 'Energía de Prueba S.A. E.S.P.',
      amount: '188420.00',
      dueDate: '2026-10-17',
      periodStart: '2026-09-15',
    });
    expect(voice.amount).toBe('180000.00');
    expect(factsOf({ transcript: 'hola' })).toBeNull();
    expect(factsOf(null)).toBeNull();
  });

  it('matches providers despite accents, societary suffixes and abbreviations', () => {
    expect(
      sameProvider('Energía de Prueba S.A. E.S.P.', 'energia de prueba'),
    ).toBe(true);
    expect(sameProvider('Agua de Prueba S.A.S.', 'Agua de Prueba SAS')).toBe(
      true,
    );
    expect(sameProvider('Agua de Prueba', 'Internet Demo')).toBe(false);
    expect(sameProvider(null, 'x')).toBe(false);
  });

  it('voice 180.000 vs Gmail 188.420 for the same provider is a contradiction', () => {
    expect(contradicts(gmail, gmail.providerName, voice)).toBe(true);
  });

  it('a different date in the same month is a contradiction', () => {
    expect(
      contradicts(gmail, gmail.providerName, {
        ...gmail,
        dueDate: '2026-10-15',
      }),
    ).toBe(true);
  });

  it('identical sources (possible duplicate) or another month are not contradictions', () => {
    expect(contradicts(gmail, gmail.providerName, { ...gmail })).toBe(false);
    expect(
      contradicts(gmail, gmail.providerName, {
        ...gmail,
        dueDate: '2026-11-17',
        periodStart: '2026-10-15',
        amount: '190000.00',
      }),
    ).toBe(false);
  });

  it('an incomplete but coherent source does not block', () => {
    expect(
      contradicts(gmail, gmail.providerName, {
        ...voice,
        amount: '188420.00',
      }),
    ).toBe(false);
  });

  it('another provider never conflicts', () => {
    expect(
      contradicts(gmail, gmail.providerName, {
        ...voice,
        providerName: 'Internet Demo',
      }),
    ).toBe(false);
  });
});
