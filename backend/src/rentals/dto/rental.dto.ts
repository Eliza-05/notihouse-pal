import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  OptionalNotNull,
  OptionalNullable,
  Trim,
} from '../../common/dto-helpers.js';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import {
  IsCalendarDate,
  IsPositiveMoneyAmount,
} from '../../common/validators.js';
import { rentalStatus } from '../../database/schema/index.js';

export const RENTAL_STATUSES = rentalStatus.enumValues;
export type RentalStatus = (typeof RENTAL_STATUSES)[number];
/** Al crear no tiene sentido un arriendo ya terminado. */
export const INITIAL_RENTAL_STATUSES = ['active', 'suspended'] as const;

/** Arriendo de un inmueble propio. El propietario se toma del JWT. */
export class CreateRentalDto {
  @ApiProperty({ format: 'uuid', description: 'Inmueble propio y activo' })
  @IsUUID()
  propertyId: string;

  @ApiPropertyOptional({
    maxLength: 120,
    example: 'Arrendatario apto 301',
    description: 'Alias del arrendatario; evita registrar datos personales',
  })
  @Trim()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  tenantAlias?: string;

  @ApiProperty({
    type: String,
    example: '950000.00',
    description: 'Canon mensual: decimal como texto, mayor que cero',
  })
  @IsPositiveMoneyAmount()
  expectedAmount: string;

  @ApiPropertyOptional({ default: 'COP', example: 'COP' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency debe ser un código ISO 4217 de 3 letras mayúsculas',
  })
  currency?: string;

  @ApiProperty({ minimum: 1, maximum: 31, example: 5 })
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay: number;

  @ApiProperty({ example: '2026-11-01' })
  @IsCalendarDate()
  startsOn: string;

  @ApiPropertyOptional({
    example: '2027-10-31',
    description: 'Opcional: arriendo sin fecha de finalización conocida',
  })
  @IsOptional()
  @IsCalendarDate()
  endsOn?: string;

  @ApiPropertyOptional({ enum: INITIAL_RENTAL_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(INITIAL_RENTAL_STATUSES)
  status?: (typeof INITIAL_RENTAL_STATUSES)[number];
}

/**
 * Campos editables del arriendo. No incluye el inmueble ni la moneda (los
 * cobros y contratos dependen de ellos) ni campos de cobros o confirmaciones.
 * No hay borrado: `status: ended` es final.
 */
export class UpdateRentalDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 120,
    description: '`null` borra el alias',
  })
  @Trim()
  @OptionalNullable()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  tenantAlias?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: '1000000.00',
    description: 'Nuevo canon; los cobros ya registrados conservan su monto',
  })
  @OptionalNotNull()
  @IsPositiveMoneyAmount()
  expectedAmount?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 31 })
  @OptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay?: number;

  @ApiPropertyOptional({ example: '2026-11-01' })
  @OptionalNotNull()
  @IsCalendarDate()
  startsOn?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2027-10-31',
    description: '`null` deja el arriendo sin fecha de finalización',
  })
  @OptionalNullable()
  @IsCalendarDate()
  endsOn?: string | null;

  @ApiPropertyOptional({
    enum: RENTAL_STATUSES,
    description: '`active` ↔ `suspended`; `ended` es final',
  })
  @OptionalNotNull()
  @IsIn(RENTAL_STATUSES)
  status?: RentalStatus;
}

export class ListRentalsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo arriendos de este inmueble propio',
  })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional({ enum: RENTAL_STATUSES })
  @IsOptional()
  @IsIn(RENTAL_STATUSES)
  status?: RentalStatus;
}

export class RentalResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  propertyId: string;

  @ApiProperty({ type: String, nullable: true })
  tenantAlias: string | null;

  @ApiProperty({ type: String, example: '950000.00' })
  expectedAmount: string;

  @ApiProperty({ example: 'COP' })
  currency: string;

  @ApiProperty({ example: 5 })
  dueDay: number;

  @ApiProperty({ example: '2026-11-01' })
  startsOn: string;

  @ApiProperty({ type: String, nullable: true, example: '2027-10-31' })
  endsOn: string | null;

  @ApiProperty({ enum: RENTAL_STATUSES })
  status: RentalStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class RentalPageDto extends PageMetaDto {
  @ApiProperty({ type: [RentalResponseDto] })
  items: RentalResponseDto[];
}
