import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, Length } from 'class-validator';
import { CASE_TYPES, type CaseType } from '../../cases/dto/case.dto.js';
import { Trim } from '../../common/dto-helpers.js';
import { IsPlainText } from '../../common/validators.js';
import { IngestionJobDto } from './ingestion.dto.js';

/** Trabajo que crea la entrada de texto; el cliente nunca elige el tipo. */
export const TEXT_INGESTION_JOB_TYPE = 'text.interpret';

/**
 * Mensaje de texto del asistente (§19.2, N1). Comparte con la voz la
 * extracción, la resolución determinística y el HITL: aquí solo se recibe
 * y se encola, igual que un documento o una nota de voz. `propertyId` es
 * una pista opcional para la resolución (ni `cases` ni `documents` tienen
 * esa columna); `obligationId`/`rentalId`/`contractId` son el sujeto del
 * caso, como máximo uno y acorde al tipo.
 */
export class CreateTextIngestionDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 1000,
    example: 'Recuérdame pagar Claro el día 7 de cada mes',
  })
  @Trim()
  @IsPlainText()
  @Length(1, 1000)
  text: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Clave de idempotencia del cliente: repetir el envío con la misma clave devuelve el registro existente (200)',
  })
  @IsOptional()
  @IsUUID()
  requestId?: string;

  @ApiPropertyOptional({ enum: CASE_TYPES, default: 'household_obligation' })
  @IsOptional()
  @IsIn(CASE_TYPES)
  caseType?: CaseType;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Inmueble propio: pista para la resolución',
  })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Obligación propia' })
  @IsOptional()
  @IsUUID()
  obligationId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Arriendo propio' })
  @IsOptional()
  @IsUUID()
  rentalId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Contrato propio' })
  @IsOptional()
  @IsUUID()
  contractId?: string;
}

/**
 * Resultado de enviar un mensaje: se recibió y quedó encolado para
 * interpretarse. No significa que ya se haya interpretado ni que exista
 * una propuesta.
 */
export class TextIngestionResponseDto {
  @ApiProperty({ format: 'uuid' })
  caseId: string;

  @ApiProperty({ format: 'uuid' })
  correlationId: string;

  @ApiProperty({ example: 'received', description: 'Estado del caso' })
  caseStatus: string;

  @ApiProperty({ enum: ['form'] })
  source: string;

  @ApiProperty({ type: IngestionJobDto })
  job: IngestionJobDto;

  @ApiProperty({
    enum: ['pending'],
    description: 'El mensaje aún no ha sido interpretado',
  })
  processing: 'pending';

  @ApiProperty({ example: 42, description: 'Longitud del texto (ya recortado)' })
  textLength: number;
}
