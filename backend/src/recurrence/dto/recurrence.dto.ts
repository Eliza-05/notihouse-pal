import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import {
  EVALUATION_CURSOR_PATTERN,
  MAX_EVALUATION_BATCH,
  MAX_EVALUATION_BATCHES,
} from '../../alerts/dto/alert.dto.js';
import { WORKER_ID_PATTERN } from '../../integrations/job-claims.js';

/** Misma forma que `POST /internal/alerts/evaluate` (§19.4). */
export class GenerateRecurrenceDto {
  @ApiProperty({
    example: 'n8n-scheduler',
    description: 'Worker que ejecuta la generación',
  })
  @Matches(WORKER_ID_PATTERN, {
    message:
      'workerId debe tener 1 a 64 caracteres: letras, números, ".", "_" o "-"',
  })
  workerId: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_EVALUATION_BATCH,
    default: 100,
    description: 'Registros por lote (cada lote es una transacción corta)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_EVALUATION_BATCH)
  batchSize?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_EVALUATION_BATCHES,
    default: 20,
    description:
      'Lotes máximos por llamada; si no alcanza, se devuelve nextCursor',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_EVALUATION_BATCHES)
  maxBatches?: number;

  @ApiPropertyOptional({ description: 'nextCursor de la llamada anterior' })
  @IsOptional()
  @Matches(EVALUATION_CURSOR_PATTERN, { message: 'cursor inválido' })
  cursor?: string;
}

export class RecurrenceSkippedDto {
  @ApiProperty({
    description:
      'Obligaciones con auto_generate activo pero sin dueDay: se omiten, nunca se inventa',
  })
  missingDueDay: number;
}

export class GenerateRecurrenceResponseDto {
  @ApiProperty({ example: '2026-11-18', description: 'Fecha de referencia' })
  evaluationDate: string;

  @ApiProperty({ example: 'America/Bogota' })
  timeZone: string;

  @ApiProperty({ format: 'uuid' })
  correlationId: string;

  @ApiProperty({ description: 'Definiciones examinadas' })
  scanned: number;

  @ApiProperty({ description: 'Períodos de obligación creados' })
  obligationPeriodsCreated: number;

  @ApiProperty({ description: 'Cobros de arriendo creados' })
  rentChargesCreated: number;

  @ApiProperty({
    description: 'Ya existían (idempotencia) o no correspondía generar',
  })
  unchanged: number;

  @ApiProperty({ type: RecurrenceSkippedDto })
  skipped: RecurrenceSkippedDto;

  @ApiProperty({
    description: 'false si quedó trabajo pendiente (usar nextCursor)',
  })
  complete: boolean;

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
