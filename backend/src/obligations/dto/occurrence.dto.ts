import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  OptionalNotNull,
  OptionalNullable,
  Trim,
} from '../../common/dto-helpers.js';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { IsCalendarDate, IsMoneyAmount } from '../../common/validators.js';
import { occurrenceStatus } from '../../database/schema/index.js';

export const OCCURRENCE_STATUSES = occurrenceStatus.enumValues;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** Estados desde los que un período todavía puede editarse o confirmarse. */
export const OPEN_OCCURRENCE_STATUSES = ['pending', 'overdue'] as const;
/** Resultados de una confirmación humana. */
export const CONFIRMATION_RESULTS = ['paid', 'attended'] as const;
export type ConfirmationResult = (typeof CONFIRMATION_RESULTS)[number];

/** Período concreto. Se crea siempre en `pending`; nunca confirmado. */
export class CreateOccurrenceDto {
  @ApiProperty({ example: '2026-11-01' })
  @IsCalendarDate()
  periodStart: string;

  @ApiProperty({ example: '2026-11-30' })
  @IsCalendarDate()
  periodEnd: string;

  @ApiProperty({ example: '2026-11-18' })
  @IsCalendarDate()
  dueDate: string;

  @ApiPropertyOptional({
    type: String,
    example: '145000.00',
    description:
      'Si se omite, se copia el valor esperado actual de la obligación',
  })
  @IsOptional()
  @IsMoneyAmount()
  amount?: string;
}

/**
 * Edición de un período pendiente o vencido. `status` solo admite
 * `cancelled` (anular sin borrar); el pago se registra con /confirm.
 */
export class UpdateOccurrenceDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @OptionalNotNull()
  @IsCalendarDate()
  periodStart?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @OptionalNotNull()
  @IsCalendarDate()
  periodEnd?: string;

  @ApiPropertyOptional({ example: '2026-11-18' })
  @OptionalNotNull()
  @IsCalendarDate()
  dueDate?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '150000.00' })
  @OptionalNullable()
  @IsMoneyAmount()
  amount?: string | null;

  @ApiPropertyOptional({ enum: ['cancelled'] })
  @OptionalNotNull()
  @IsIn(['cancelled'], {
    message:
      'status solo admite "cancelled"; para registrar un pago usa /confirm',
  })
  status?: 'cancelled';
}

/** Declaración del usuario: pagó o atendió la obligación. No ejecuta pagos. */
export class ConfirmOccurrenceDto {
  @ApiProperty({ enum: CONFIRMATION_RESULTS })
  @IsIn(CONFIRMATION_RESULTS)
  result: ConfirmationResult;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Número de comprobante o nota del usuario',
  })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

export class ListOccurrencesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OCCURRENCE_STATUSES })
  @IsOptional()
  @IsIn(OCCURRENCE_STATUSES)
  status?: OccurrenceStatus;
}

export class OccurrenceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  obligationId: string;

  @ApiProperty({ example: '2026-11-01' })
  periodStart: string;

  @ApiProperty({ example: '2026-11-30' })
  periodEnd: string;

  @ApiProperty({ type: String, nullable: true, example: '145000.00' })
  amount: string | null;

  @ApiProperty({ example: 'COP' })
  currency: string;

  @ApiProperty({ example: '2026-11-18' })
  dueDate: string;

  @ApiProperty({ enum: OCCURRENCE_STATUSES })
  status: OccurrenceStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  confirmedBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  confirmationReference: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class OccurrencePageDto extends PageMetaDto {
  @ApiProperty({ type: [OccurrenceResponseDto] })
  items: OccurrenceResponseDto[];
}
