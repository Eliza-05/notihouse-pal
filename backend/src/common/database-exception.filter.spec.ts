import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { toHttpException } from './database-exception.filter.js';

/** Simula un error de `pg` envuelto por Drizzle (DrizzleQueryError → cause). */
const wrapped = (fields: Record<string, string>, message = 'db error') => {
  const cause = Object.assign(new Error(message), fields);
  return new Error('Failed query: insert into ...', { cause });
};

describe('toHttpException', () => {
  it('maps a known unique violation to 409 with a friendly message', () => {
    const mapped = toHttpException(
      wrapped({
        code: '23505',
        constraint: 'obligation_occurrences_period_unique',
      }),
    );
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped!.message).toBe(
      'Ya existe un período con esa fecha de inicio para esta obligación',
    );
  });

  it('uses a generic conflict message for other unique constraints', () => {
    expect(
      toHttpException(wrapped({ code: '23505', constraint: 'x' }))!.message,
    ).toBe('Conflicto con datos existentes');
  });

  it.each(['23502', '23514', '23503', '22P02', '22007', '22008', '22003'])(
    'maps %s to 400 without exposing SQL',
    (code) => {
      const mapped = toHttpException(
        wrapped({ code }, 'violates check constraint "secret_name"'),
      );
      expect(mapped).toBeInstanceOf(BadRequestException);
      expect(mapped!.message).not.toContain('secret_name');
    },
  );

  it.each(['ECONNREFUSED', 'ETIMEDOUT', '57P01', '08006', '53300'])(
    'maps connection error %s to 503',
    (code) => {
      expect(toHttpException(wrapped({ code }))).toBeInstanceOf(
        ServiceUnavailableException,
      );
    },
  );

  it('maps pool timeouts without a code to 503', () => {
    expect(
      toHttpException(
        new Error('x', {
          cause: new Error('timeout exceeded when trying to connect'),
        }),
      ),
    ).toBeInstanceOf(ServiceUnavailableException);
  });

  it('leaves unknown errors untouched (default 500)', () => {
    expect(toHttpException(new Error('boom'))).toBeNull();
    expect(toHttpException(wrapped({ code: 'XX000' }))).toBeNull();
    expect(toHttpException('not an error')).toBeNull();
  });
});
