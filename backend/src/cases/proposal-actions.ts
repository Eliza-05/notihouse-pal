import { BadRequestException } from '@nestjs/common';
import { OmitType } from '@nestjs/swagger';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  Max,
  Min,
  validate,
  ValidateNested,
  type ValidationError,
} from 'class-validator';
import {
  OptionalNotNull,
  OptionalNullable,
} from '../common/dto-helpers.js';
import { IsCalendarDate, IsMoneyAmount } from '../common/validators.js';
import { isJsonObject } from '../common/validators.js';
import { proposalApplicationAction } from '../database/schema/index.js';
import { CreateObligationDto } from '../obligations/dto/obligation.dto.js';
import { CreateOccurrenceDto } from '../obligations/dto/occurrence.dto.js';
import { CreateRentalDto } from '../rentals/dto/rental.dto.js';

/**
 * Lista cerrada de operaciones que una propuesta aprobada puede ejecutar.
 * Cualquier otro valor (marcar pagado, confirmar un cobro, renovar un
 * contrato, cambiar propietarios...) se rechaza: no existe código que lo haga.
 */
export const PROPOSAL_ACTIONS = proposalApplicationAction.enumValues;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/**
 * `create_obligation_occurrence`: período `pending` de una obligación
 * existente. Mismas validaciones que `POST /obligations/:id/occurrences`;
 * `currency`, si viene, debe coincidir con la de la obligación.
 */
export class CreateOccurrenceActionData extends CreateOccurrenceDto {
  @IsUUID()
  obligationId: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency debe ser un código ISO 4217 de 3 letras mayúsculas',
  })
  currency?: string;
}

/** Definición propuesta: igual que `POST /obligations`, siempre `active`. */
export class ProposedObligationDto extends OmitType(CreateObligationDto, [
  'status',
] as const) {}

/** `create_obligation_with_occurrence`: definición nueva y su primer período. */
export class CreateObligationWithOccurrenceData {
  @IsDefined()
  @ValidateNested()
  @Type(() => ProposedObligationDto)
  obligation: ProposedObligationDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => CreateOccurrenceDto)
  occurrence: CreateOccurrenceDto;
}

/**
 * `create_recurring_obligation`: definición nueva con `autoGenerate` siempre
 * `true` y `dueDay` obligatorio (sin él no hay nada que generar).
 */
export class ProposedRecurringObligationDto extends OmitType(
  CreateObligationDto,
  ['status', 'dueDay', 'autoGenerate'] as const,
) {
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay: number;
}

export class CreateRecurringObligationActionData {
  @IsDefined()
  @ValidateNested()
  @Type(() => ProposedRecurringObligationDto)
  obligation: ProposedRecurringObligationDto;
}

/**
 * Solo `dueDay`, `reminderDaysBefore` y `expectedAmount` son modificables por
 * IA (§19.5: frecuencia, proveedor, concepto, categoría, inmueble y moneda
 * quedan solo manuales). Se usa dos veces: `expected` (valores vigentes que
 * el backend vuelve a comprobar, control optimista) y `changes` (valores
 * nuevos) de `update_obligation_schedule`.
 */
export class ScheduleFieldsDto {
  @IsOptional()
  @OptionalNullable()
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay?: number | null;

  @IsOptional()
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(60)
  reminderDaysBefore?: number;

  @IsOptional()
  @OptionalNullable()
  @IsMoneyAmount()
  expectedAmount?: string | null;
}

/**
 * `update_obligation_schedule`: la obligación identificada inequívocamente
 * por `resolve` (§19.5, D17: nunca varias a la vez). `expected` coincide con
 * lo que hay hoy en la base (409 si cambió); `changes` son los valores
 * nuevos, con al menos un cambio real.
 */
export class UpdateObligationScheduleActionData {
  @IsUUID()
  obligationId: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => ScheduleFieldsDto)
  expected: ScheduleFieldsDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => ScheduleFieldsDto)
  changes: ScheduleFieldsDto;
}

/**
 * `update_occurrence_details`: aporta el monto o la fecha reales a un
 * período `pending` ya generado (§19.4, "llegada posterior de una
 * factura"). Nunca toca un período confirmado o anulado.
 */
export class UpdateOccurrenceDetailsActionData {
  @IsUUID()
  obligationId: string;

  @IsUUID()
  occurrenceId: string;

  @IsOptional()
  @IsMoneyAmount()
  amount?: string;

  @IsOptional()
  @IsCalendarDate()
  dueDate?: string;
}

/** `create_recurring_rental`: arriendo nuevo, siempre `active` y `autoGenerate = true`. */
export class ProposedRentalDto extends OmitType(CreateRentalDto, [
  'status',
  'autoGenerate',
] as const) {}

export class CreateRecurringRentalActionData {
  @IsDefined()
  @ValidateNested()
  @Type(() => ProposedRentalDto)
  rental: ProposedRentalDto;
}

/** Control optimista del archivado: nombre y concepto vigentes cuando se preparó la propuesta. */
export class ArchiveExpectedDto {
  @IsString()
  @MaxLength(120)
  providerName: string;

  @IsString()
  @MaxLength(160)
  concept: string;
}

/**
 * `archive_obligation`: archiva (NUNCA borra) la obligación identificada
 * inequívocamente por `resolve` o elegida por la persona entre alternativas
 * reales. Misma regla de negocio que el archivado manual. `expected` evita
 * archivar una obligación que cambió desde que se preparó la propuesta.
 */
export class ArchiveObligationActionData {
  @IsUUID()
  obligationId: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => ArchiveExpectedDto)
  expected: ArchiveExpectedDto;
}

export type ParsedProposalAction =
  | { action: 'create_obligation_occurrence'; data: CreateOccurrenceActionData }
  | {
      action: 'create_obligation_with_occurrence';
      data: CreateObligationWithOccurrenceData;
    }
  | {
      action: 'create_recurring_obligation';
      data: CreateRecurringObligationActionData;
    }
  | {
      action: 'update_obligation_schedule';
      data: UpdateObligationScheduleActionData;
    }
  | {
      action: 'update_occurrence_details';
      data: UpdateOccurrenceDetailsActionData;
    }
  | { action: 'create_recurring_rental'; data: CreateRecurringRentalActionData }
  | { action: 'archive_obligation'; data: ArchiveObligationActionData };

const ENVELOPE_KEYS = ['action', 'data'];

const ACTION_CLASSES = {
  create_obligation_occurrence: CreateOccurrenceActionData,
  create_obligation_with_occurrence: CreateObligationWithOccurrenceData,
  create_recurring_obligation: CreateRecurringObligationActionData,
  update_obligation_schedule: UpdateObligationScheduleActionData,
  update_occurrence_details: UpdateOccurrenceDetailsActionData,
  create_recurring_rental: CreateRecurringRentalActionData,
  archive_obligation: ArchiveObligationActionData,
} as const satisfies Record<ProposalAction, new () => object>;

/**
 * Interpreta `proposed_data` como `{ action, data }`. Solo se aceptan las
 * acciones de la lista y los campos declarados en sus DTO (cualquier campo
 * extra, como `status`, `confirmedBy` u `ownerId`, invalida la propuesta).
 * Nunca se usan nombres de tabla, columnas ni SQL provenientes del JSON.
 */
export async function parseProposalAction(
  proposedData: unknown,
): Promise<ParsedProposalAction> {
  if (
    !isJsonObject(proposedData) ||
    Object.keys(proposedData).some((key) => !ENVELOPE_KEYS.includes(key))
  ) {
    throw new BadRequestException(
      'La propuesta no tiene el formato aplicable { action, data }',
    );
  }
  const { action, data } = proposedData;
  if (
    typeof action !== 'string' ||
    !(PROPOSAL_ACTIONS as readonly string[]).includes(action)
  ) {
    throw new BadRequestException(
      'La propuesta no contiene una acción permitida; debe completarse manualmente',
    );
  }
  if (!isJsonObject(data)) {
    throw new BadRequestException('La propuesta no contiene datos aplicables');
  }

  const typedAction = action as ProposalAction;
  const parsedData: object = plainToInstance(
    ACTION_CLASSES[typedAction] as new () => object,
    data,
  );
  const errors = await validate(parsedData, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    throw new BadRequestException(flattenErrors(errors));
  }
  return { action: typedAction, data: parsedData } as ParsedProposalAction;
}

function flattenErrors(errors: ValidationError[], prefix = 'data'): string[] {
  return errors.flatMap((error) => {
    const path = `${prefix}.${error.property}`;
    const own = Object.values(error.constraints ?? {}).map(
      (message) => `${path}: ${message}`,
    );
    return [...own, ...flattenErrors(error.children ?? [], path)];
  });
}
