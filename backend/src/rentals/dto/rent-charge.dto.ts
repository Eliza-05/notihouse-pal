import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { OptionalNotNull, Trim } from '../../common/dto-helpers.js';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import {
  IsCalendarDate,
  IsPositiveMoneyAmount,
} from '../../common/validators.js';
import { rentChargeStatus } from '../../database/schema/index.js';

export const RENT_CHARGE_STATUSES = rentChargeStatus.enumValues;
export type RentChargeStatus = (typeof RENT_CHARGE_STATUSES)[number];

/** Estados desde los que un cobro todavía puede editarse o confirmarse. */
export const OPEN_RENT_CHARGE_STATUSES = [
  'expected',
  'pending',
  'overdue',
] as const;

/** Cobro esperado de un período. Se crea siempre en `expected`; nunca recibido. */
export class CreateRentChargeDto {
  @ApiProperty({ example: '2026-11-01' })
  @IsCalendarDate()
  periodStart: string;

  @ApiProperty({ example: '2026-11-30' })
  @IsCalendarDate()
  periodEnd: string;

  @ApiProperty({ example: '2026-11-05' })
  @IsCalendarDate()
  dueDate: string;

  @ApiPropertyOptional({
    type: String,
    example: '950000.00',
    description: 'Si se omite, se copia el canon vigente del arriendo',
  })
  @IsOptional()
  @IsPositiveMoneyAmount()
  expectedAmount?: string;
}

/**
 * Edición de un cobro abierto (`expected`, `pending`, `overdue`). `status`
 * solo admite `cancelled` (anular sin borrar); la recepción se registra con /confirm.
 */
export class UpdateRentChargeDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @OptionalNotNull()
  @IsCalendarDate()
  periodStart?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @OptionalNotNull()
  @IsCalendarDate()
  periodEnd?: string;

  @ApiPropertyOptional({ example: '2026-11-05' })
  @OptionalNotNull()
  @IsCalendarDate()
  dueDate?: string;

  @ApiPropertyOptional({ type: String, example: '1000000.00' })
  @OptionalNotNull()
  @IsPositiveMoneyAmount()
  expectedAmount?: string;

  @ApiPropertyOptional({ enum: ['cancelled'] })
  @OptionalNotNull()
  @IsIn(['cancelled'], {
    message:
      'status solo admite "cancelled"; para registrar la recepción usa /confirm',
  })
  status?: 'cancelled';
}

/**
 * Declaración del propietario: recibió el cobro. NotiHouse-Pal no verifica
 * transferencias; `evidence` es la referencia o nota que el propio usuario aporta.
 */
export class ConfirmRentChargeDto {
  @ApiProperty({
    maxLength: 500,
    example: 'Recibido en efectivo el 5 de noviembre',
    description:
      'Obligatoria: referencia de la transferencia o nota del propietario sobre la recepción',
  })
  @Trim()
  @IsString()
  @IsNotEmpty({
    message: 'evidence es obligatoria para confirmar la recepción',
  })
  @MaxLength(500)
  evidence: string;
}

export class ListRentChargesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RENT_CHARGE_STATUSES })
  @IsOptional()
  @IsIn(RENT_CHARGE_STATUSES)
  status?: RentChargeStatus;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Solo cobros cuyo período inicia en esta fecha o después',
  })
  @IsOptional()
  @IsCalendarDate()
  periodFrom?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'Solo cobros cuyo período inicia en esta fecha o antes',
  })
  @IsOptional()
  @IsCalendarDate()
  periodTo?: string;
}

export class RentChargeResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  rentalId: string;

  @ApiProperty({ example: '2026-11-01' })
  periodStart: string;

  @ApiProperty({ example: '2026-11-30' })
  periodEnd: string;

  @ApiProperty({ type: String, example: '950000.00' })
  expectedAmount: string;

  @ApiProperty({ example: 'COP' })
  currency: string;

  @ApiProperty({ example: '2026-11-05' })
  dueDate: string;

  @ApiProperty({ enum: RENT_CHARGE_STATUSES })
  status: RentChargeStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  confirmedBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  confirmationEvidence: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class RentChargePageDto extends PageMetaDto {
  @ApiProperty({ type: [RentChargeResponseDto] })
  items: RentChargeResponseDto[];
}
