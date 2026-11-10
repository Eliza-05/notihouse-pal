import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  OptionalNotNull,
  OptionalNullable,
  QueryBoolean,
  Trim,
} from '../../common/dto-helpers.js';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { IsCalendarDate, IsMoneyAmount } from '../../common/validators.js';
import {
  obligationCategory,
  obligationStatus,
  recurrenceFrequency,
} from '../../database/schema/index.js';

export const OBLIGATION_CATEGORIES = obligationCategory.enumValues;
export const OBLIGATION_FREQUENCIES = recurrenceFrequency.enumValues;
export const OBLIGATION_STATUSES = obligationStatus.enumValues;
/** Al crear no tiene sentido una obligación ya archivada. */
export const INITIAL_OBLIGATION_STATUSES = ['active', 'paused'] as const;

type Category = (typeof OBLIGATION_CATEGORIES)[number];
type Frequency = (typeof OBLIGATION_FREQUENCIES)[number];
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

/** Definición de una obligación recurrente. El propietario se toma del JWT. */
export class CreateObligationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Inmueble propio y activo (opcional)',
  })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiProperty({ example: 'Empresa de energía', maxLength: 120 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  providerName: string;

  @ApiProperty({ example: 'Energía eléctrica', maxLength: 160 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  concept: string;

  @ApiProperty({ enum: OBLIGATION_CATEGORIES })
  @IsIn(OBLIGATION_CATEGORIES)
  category: Category;

  @ApiPropertyOptional({
    type: String,
    example: '145000.00',
    description: 'Decimal como texto, máx. 2 decimales',
  })
  @IsOptional()
  @IsMoneyAmount()
  expectedAmount?: string;

  @ApiPropertyOptional({ default: 'COP', example: 'COP' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency debe ser un código ISO 4217 de 3 letras mayúsculas',
  })
  currency?: string;

  @ApiPropertyOptional({ enum: OBLIGATION_FREQUENCIES, default: 'monthly' })
  @IsOptional()
  @IsIn(OBLIGATION_FREQUENCIES)
  frequency?: Frequency;

  @ApiPropertyOptional({ minimum: 1, maximum: 31 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 60, default: 3 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  reminderDaysBefore?: number;

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsCalendarDate()
  startsOn?: string;

  @ApiPropertyOptional({ enum: INITIAL_OBLIGATION_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(INITIAL_OBLIGATION_STATUSES)
  status?: (typeof INITIAL_OBLIGATION_STATUSES)[number];

  @ApiPropertyOptional({
    default: false,
    description:
      'Generar automáticamente los próximos períodos. No cobra ni envía mensajes.',
  })
  @IsOptional()
  @IsBoolean()
  autoGenerate?: boolean;
}

/**
 * Campos editables de la definición. No incluye la moneda (los períodos
 * históricos la conservan) ni campos de períodos o confirmaciones.
 * No hay borrado: se usa `status: paused` o `archived` (este último es final).
 */
export class UpdateObligationDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: '`null` desvincula el inmueble',
  })
  @OptionalNullable()
  @IsUUID()
  propertyId?: string | null;

  @ApiPropertyOptional({ maxLength: 120 })
  @Trim()
  @OptionalNotNull()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  providerName?: string;

  @ApiPropertyOptional({ maxLength: 160 })
  @Trim()
  @OptionalNotNull()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  concept?: string;

  @ApiPropertyOptional({ enum: OBLIGATION_CATEGORIES })
  @OptionalNotNull()
  @IsIn(OBLIGATION_CATEGORIES)
  category?: Category;

  @ApiPropertyOptional({ type: String, nullable: true, example: '150000.00' })
  @OptionalNullable()
  @IsMoneyAmount()
  expectedAmount?: string | null;

  @ApiPropertyOptional({ enum: OBLIGATION_FREQUENCIES })
  @OptionalNotNull()
  @IsIn(OBLIGATION_FREQUENCIES)
  frequency?: Frequency;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 31,
  })
  @OptionalNullable()
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 60 })
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(60)
  reminderDaysBefore?: number;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-01-01' })
  @OptionalNullable()
  @IsCalendarDate()
  startsOn?: string | null;

  @ApiPropertyOptional({ enum: OBLIGATION_STATUSES })
  @OptionalNotNull()
  @IsIn(OBLIGATION_STATUSES)
  status?: ObligationStatus;

  @ApiPropertyOptional({
    description:
      'Generar automáticamente los próximos períodos. No cobra ni envía mensajes.',
  })
  @OptionalNotNull()
  @IsBoolean()
  autoGenerate?: boolean;
}

export class ListObligationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo obligaciones de este inmueble propio',
  })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional({ enum: OBLIGATION_STATUSES })
  @IsOptional()
  @IsIn(OBLIGATION_STATUSES)
  status?: ObligationStatus;

  @ApiPropertyOptional({ enum: OBLIGATION_CATEGORIES })
  @IsOptional()
  @IsIn(OBLIGATION_CATEGORIES)
  category?: Category;

  @ApiPropertyOptional({
    description: 'Búsqueda por proveedor o concepto (insensible a mayúsculas)',
    minLength: 2,
    maxLength: 60,
  })
  @Trim()
  @IsOptional()
  @IsString()
  @Length(2, 60)
  q?: string;

  @ApiPropertyOptional({
    description:
      'Solo obligaciones sin inmueble asignado. Incompatible con propertyId.',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  unassigned?: boolean;
}

export class ObligationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  propertyId: string | null;

  @ApiProperty()
  providerName: string;

  @ApiProperty()
  concept: string;

  @ApiProperty({ enum: OBLIGATION_CATEGORIES })
  category: Category;

  @ApiProperty({ type: String, nullable: true, example: '145000.00' })
  expectedAmount: string | null;

  @ApiProperty({ example: 'COP' })
  currency: string;

  @ApiProperty({ enum: OBLIGATION_FREQUENCIES })
  frequency: Frequency;

  @ApiProperty({ type: Number, nullable: true })
  dueDay: number | null;

  @ApiProperty()
  reminderDaysBefore: number;

  @ApiProperty({ type: String, nullable: true, example: '2026-01-01' })
  startsOn: string | null;

  @ApiProperty({ enum: OBLIGATION_STATUSES })
  status: ObligationStatus;

  @ApiProperty()
  autoGenerate: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class ObligationPageDto extends PageMetaDto {
  @ApiProperty({ type: [ObligationResponseDto] })
  items: ObligationResponseDto[];
}
