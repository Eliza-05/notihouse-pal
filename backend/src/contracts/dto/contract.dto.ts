import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { OptionalNotNull, OptionalNullable } from '../../common/dto-helpers.js';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { IsCalendarDate } from '../../common/validators.js';
import { contractStatus } from '../../database/schema/index.js';

export const CONTRACT_STATUSES = contractStatus.enumValues;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * Metadatos de un contrato. Siempre se crea `active`; no se generan ni
 * firman documentos. El propietario se toma del JWT.
 */
export class CreateContractDto {
  @ApiProperty({ format: 'uuid', description: 'Inmueble propio y activo' })
  @IsUUID()
  propertyId: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Arriendo propio asociado; debe pertenecer al mismo inmueble',
  })
  @IsOptional()
  @IsUUID()
  rentalId?: string;

  @ApiProperty({ example: '2026-11-01' })
  @IsCalendarDate()
  startsOn: string;

  @ApiProperty({
    example: '2027-10-31',
    description:
      'Obligatoria: sin fecha de finalización no se puede vigilar el vencimiento',
  })
  @IsDefined({
    message:
      'endsOn es obligatoria: registra el contrato cuando conozcas su fecha de finalización',
  })
  @IsCalendarDate()
  endsOn: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 365,
    example: 30,
    description: 'Días de preaviso pactados',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Documento propio de tipo `contract` ya registrado',
  })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

/**
 * Corrección manual de metadatos. El inmueble y el arriendo asociados no se
 * pueden cambiar. `status` admite pasar de `active` a `expired` o
 * `terminated`; un contrato vencido o terminado ya no admite cambios.
 */
export class UpdateContractDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @OptionalNotNull()
  @IsCalendarDate()
  startsOn?: string;

  @ApiPropertyOptional({ example: '2027-10-31' })
  @OptionalNotNull()
  @IsCalendarDate()
  endsOn?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 365,
  })
  @OptionalNullable()
  @IsInt()
  @Min(0)
  @Max(365)
  noticePeriodDays?: number | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: '`null` desvincula el documento',
  })
  @OptionalNullable()
  @IsUUID()
  documentId?: string | null;

  @ApiPropertyOptional({ enum: CONTRACT_STATUSES })
  @OptionalNotNull()
  @IsIn(CONTRACT_STATUSES)
  status?: ContractStatus;
}

export class ListContractsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo contratos de este inmueble propio',
  })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo contratos de este arriendo propio',
  })
  @IsOptional()
  @IsUUID()
  rentalId?: string;

  @ApiPropertyOptional({ enum: CONTRACT_STATUSES })
  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: ContractStatus;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Solo contratos que finalizan en esta fecha o después',
  })
  @IsOptional()
  @IsCalendarDate()
  endsFrom?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'Solo contratos que finalizan en esta fecha o antes',
  })
  @IsOptional()
  @IsCalendarDate()
  endsTo?: string;
}

export class ContractResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  propertyId: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  rentalId: string | null;

  @ApiProperty({ example: '2026-11-01' })
  startsOn: string;

  @ApiProperty({ example: '2027-10-31' })
  endsOn: string;

  @ApiProperty({ type: Number, nullable: true, example: 30 })
  noticePeriodDays: number | null;

  @ApiProperty({ enum: CONTRACT_STATUSES })
  status: ContractStatus;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  documentId: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class ContractPageDto extends PageMetaDto {
  @ApiProperty({ type: [ContractResponseDto] })
  items: ContractResponseDto[];
}
