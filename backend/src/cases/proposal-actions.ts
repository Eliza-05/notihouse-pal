import { BadRequestException } from '@nestjs/common';
import { OmitType } from '@nestjs/swagger';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsDefined,
  IsOptional,
  IsUUID,
  Matches,
  validate,
  ValidateNested,
  type ValidationError,
} from 'class-validator';
import { isJsonObject } from '../common/validators.js';
import { proposalApplicationAction } from '../database/schema/index.js';
import { CreateObligationDto } from '../obligations/dto/obligation.dto.js';
import { CreateOccurrenceDto } from '../obligations/dto/occurrence.dto.js';

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

export type ParsedProposalAction =
  | { action: 'create_obligation_occurrence'; data: CreateOccurrenceActionData }
  | {
      action: 'create_obligation_with_occurrence';
      data: CreateObligationWithOccurrenceData;
    };

const ENVELOPE_KEYS = ['action', 'data'];

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

  const parsed: ParsedProposalAction =
    action === 'create_obligation_occurrence'
      ? { action, data: plainToInstance(CreateOccurrenceActionData, data) }
      : {
          action: 'create_obligation_with_occurrence',
          data: plainToInstance(CreateObligationWithOccurrenceData, data),
        };
  const errors = await validate(parsed.data, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    throw new BadRequestException(flattenErrors(errors));
  }
  return parsed;
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
