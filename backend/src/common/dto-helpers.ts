import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';

/** Recorta espacios en cadenas; otros tipos llegan intactos para que la validación los rechace. */
export const Trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Campo opcional que, si se envía, no puede ser `null`
 * (`@IsOptional()` dejaría pasar `null` hacia columnas NOT NULL).
 */
export const OptionalNotNull = () =>
  ValidateIf((_object, value) => value !== undefined);

/** Campo opcional que admite `null` para borrar su valor. */
export const OptionalNullable = () =>
  ValidateIf((_object, value) => value !== undefined && value !== null);

/** Rechaza un PATCH sin ningún campo editable. */
export function assertHasChanges(dto: object): void {
  if (Object.values(dto).every((value) => value === undefined)) {
    throw new BadRequestException(
      'Debe indicar al menos un campo para actualizar',
    );
  }
}

/**
 * Campos del parche cuyo valor difiere del registro actual
 * (los `undefined` se ignoran: significan "no modificar").
 */
export function diffPatch<P extends object>(
  current: { [K in keyof P]: unknown },
  patch: P,
): { changes: (keyof P & string)[]; values: Partial<P> } {
  const changes = (Object.keys(patch) as (keyof P & string)[]).filter(
    (key) => patch[key] !== undefined && patch[key] !== current[key],
  );
  const values: Partial<P> = {};
  for (const key of changes) values[key] = patch[key];
  return { changes, values };
}

/**
 * Exige `end >= start` para fechas `YYYY-MM-DD` ya validadas (su orden
 * lexicográfico coincide con el cronológico). Un `end` nulo no se compara.
 */
export function assertDateOrder(
  start: string,
  end: string | null,
  startName: string,
  endName: string,
): void {
  if (end !== null && end < start) {
    throw new BadRequestException(
      `${endName} no puede ser anterior a ${startName}`,
    );
  }
}
