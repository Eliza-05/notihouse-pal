import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { caseType, inputSource } from '../../database/schema/index.js';
import { CASE_STATUSES, type CaseStatus } from '../case-lifecycle.js';

export const CASE_TYPES = caseType.enumValues;
export type CaseType = (typeof CASE_TYPES)[number];

/** Entidad de negocio que corresponde a cada tipo de caso. */
export const CASE_SUBJECT_FIELD = {
  household_obligation: 'obligationId',
  rent_collection: 'rentalId',
  contract_review: 'contractId',
} as const satisfies Record<CaseType, string>;

/**
 * Caso iniciado por el usuario desde la aplicación (origen `form`). El estado
 * inicial (`received`), el `correlation_id` y el propietario los asigna el
 * servidor. Los casos de origen documento, Gmail o voz se crearán con los
 * flujos de ingesta de fases posteriores.
 */
export class CreateCaseDto {
  @ApiProperty({ enum: CASE_TYPES })
  @IsIn(CASE_TYPES)
  type: CaseType;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligación propia (solo para household_obligation)',
  })
  @IsOptional()
  @IsUUID()
  obligationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Arriendo propio (solo para rent_collection)',
  })
  @IsOptional()
  @IsUUID()
  rentalId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Contrato propio (solo para contract_review)',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Clave de idempotencia generada por el cliente. Repetir la solicitud con la misma clave devuelve el caso ya creado (200).',
  })
  @IsOptional()
  @IsUUID()
  requestId?: string;
}

export class ListCasesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CASE_STATUSES })
  @IsOptional()
  @IsIn(CASE_STATUSES)
  status?: CaseStatus;

  @ApiPropertyOptional({ enum: CASE_TYPES })
  @IsOptional()
  @IsIn(CASE_TYPES)
  type?: CaseType;
}

export class CaseResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Identificador de trazabilidad de todo el proceso',
  })
  correlationId: string;

  @ApiProperty({ enum: CASE_TYPES })
  type: CaseType;

  @ApiProperty({ enum: inputSource.enumValues })
  source: string;

  @ApiProperty({ enum: CASE_STATUSES })
  status: CaseStatus;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  obligationId: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  rentalId: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  contractId: string | null;

  @ApiProperty({ type: String, nullable: true })
  statusReason: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class CasePageDto extends PageMetaDto {
  @ApiProperty({ type: [CaseResponseDto] })
  items: CaseResponseDto[];
}
