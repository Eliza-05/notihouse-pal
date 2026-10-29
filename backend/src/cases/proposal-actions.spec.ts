import { BadRequestException } from '@nestjs/common';
import { parseProposalAction } from './proposal-actions.js';

const OBLIGATION = '7d1f8a9e-2b3c-4d5e-8f60-718293a4b5c6';
const occurrenceData = {
  obligationId: OBLIGATION,
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  dueDate: '2026-11-18',
  amount: '145000.00',
};

const rejects = async (proposedData: unknown, pattern?: RegExp) => {
  const error = await parseProposalAction(proposedData).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  if (pattern) {
    expect(
      JSON.stringify((error as BadRequestException).getResponse()),
    ).toMatch(pattern);
  }
};

describe('parseProposalAction (allow-list)', () => {
  it('accepts create_obligation_occurrence with valid data', async () => {
    const parsed = await parseProposalAction({
      action: 'create_obligation_occurrence',
      data: occurrenceData,
    });
    expect(parsed.action).toBe('create_obligation_occurrence');
    expect(parsed.data).toMatchObject(occurrenceData);
  });

  it('accepts create_obligation_with_occurrence', async () => {
    const parsed = await parseProposalAction({
      action: 'create_obligation_with_occurrence',
      data: {
        obligation: {
          providerName: '  Acueducto ',
          concept: 'Agua',
          category: 'water',
        },
        occurrence: {
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          dueDate: '2026-11-20',
        },
      },
    });
    expect(parsed.action).toBe('create_obligation_with_occurrence');
    if (parsed.action === 'create_obligation_with_occurrence') {
      expect(parsed.data.obligation.providerName).toBe('Acueducto');
    }
  });

  it.each([
    'mark_occurrence_paid',
    'confirm_rent_charge',
    'renew_contract',
    'change_owner',
    'delete_history',
    'execute_sql',
    'CREATE_OBLIGATION_OCCURRENCE',
  ])('rejects the unknown or forbidden action %s', async (action) => {
    await rejects({ action, data: occurrenceData }, /acción permitida/);
  });

  it.each([
    ['status (marcar pagado)', { status: 'paid' }],
    ['confirmedBy', { confirmedBy: OBLIGATION }],
    ['confirmedAt', { confirmedAt: '2026-11-18T00:00:00Z' }],
    ['ownerId', { ownerId: OBLIGATION }],
    ['table', { table: 'rent_charges' }],
  ])('rejects undeclared field %s', async (_label, extra) => {
    await rejects(
      {
        action: 'create_obligation_occurrence',
        data: { ...occurrenceData, ...extra },
      },
      /should not exist/,
    );
  });

  it('rejects undeclared fields inside nested objects', async () => {
    await rejects(
      {
        action: 'create_obligation_with_occurrence',
        data: {
          obligation: {
            providerName: 'X',
            concept: 'Y',
            category: 'water',
            status: 'archived',
          },
          occurrence: {
            periodStart: '2026-11-01',
            periodEnd: '2026-11-30',
            dueDate: '2026-11-20',
            status: 'paid',
          },
        },
      },
      /data\.obligation\.status.*data\.occurrence\.status|data\.occurrence\.status.*data\.obligation\.status/s,
    );
  });

  it.each([
    ['negative amount', { amount: '-5' }],
    ['float amount', { amount: 145000.5 }],
    ['three decimals', { amount: '1.005' }],
    ['impossible date', { dueDate: '2026-02-30' }],
    ['bad currency', { currency: 'cop' }],
    ['bad obligation id', { obligationId: 'abc' }],
  ])('rejects invalid financial data: %s', async (_label, patch) => {
    await rejects({
      action: 'create_obligation_occurrence',
      data: { ...occurrenceData, ...patch },
    });
  });

  it.each([
    ['null', null],
    ['array', [{ action: 'create_obligation_occurrence' }]],
    ['missing data', { action: 'create_obligation_occurrence' }],
    [
      'extra top-level key',
      {
        action: 'create_obligation_occurrence',
        data: occurrenceData,
        sql: 'DROP',
      },
    ],
    ['free-form AI output', { amount: '145000.00', dueDate: '2026-11-18' }],
  ])('rejects a non-applicable envelope (%s)', async (_label, proposedData) => {
    await rejects(proposedData);
  });

  it('requires both nested objects for a new obligation', async () => {
    await rejects({
      action: 'create_obligation_with_occurrence',
      data: {
        obligation: { providerName: 'X', concept: 'Y', category: 'water' },
      },
    });
  });
});
