import { registerDecorator, type ValidationOptions } from 'class-validator';

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` que corresponde a un día real del calendario (rechaza 2026-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export function IsCalendarDate(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} debe ser una fecha válida con formato YYYY-MM-DD`,
        ...options,
      },
      validator: { validate: isCalendarDate },
    });
}

/**
 * Valor monetario exacto como cadena decimal: hasta 12 dígitos enteros y 2
 * decimales, sin signo (columnas numeric(14,2) no negativas). Nunca number,
 * para no perder precisión con coma flotante.
 */
export const MONEY_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;

export function isMoneyAmount(value: unknown): value is string {
  return typeof value === 'string' && MONEY_PATTERN.test(value);
}

export function IsMoneyAmount(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isMoneyAmount',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} debe ser un monto decimal no negativo como texto, con máximo 2 decimales (p. ej. "145000.00")`,
        ...options,
      },
      validator: { validate: isMoneyAmount },
    });
}

/** Como `isMoneyAmount`, pero mayor que cero (cánones y cobros de arriendo). */
export function isPositiveMoneyAmount(value: unknown): value is string {
  return isMoneyAmount(value) && /[1-9]/.test(value);
}

export function IsPositiveMoneyAmount(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isPositiveMoneyAmount',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} debe ser un monto decimal mayor que cero como texto, con máximo 2 decimales (p. ej. "950000.00")`,
        ...options,
      },
      validator: { validate: isPositiveMoneyAmount },
    });
}
