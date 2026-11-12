import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Trim } from '../../common/dto-helpers.js';
import { IsCalendarDate, IsMoneyAmount } from '../../common/validators.js';
import { obligationCategory, recurrenceFrequency } from '../../database/schema/index.js';
import { ClaimReferenceDto } from '../dto/process.dto.js';

export const EXTRACTION_INTENTS = [
  'create_recurring_obligation',
  'register_invoice',
  'update_obligation_schedule',
  'archive_obligation',
  'create_recurring_rental',
  'declare_payment',
  'declare_rent_received',
  'report_rent_unpaid',
  'unsupported',
] as const;
export type ExtractionIntent = (typeof EXTRACTION_INTENTS)[number];

export const RESOLVE_OUTCOMES = [
  'applicable',
  'needs_choice',
  'needs_completion',
  'guided_manual',
  'informational',
  'unsupported',
] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOMES)[number];

/**
 * Esquema único de extracción (§20.3), igual para voz y texto. Lo produce
 * n8n (grounding, ambigüedad, inyección); `resolve` solo lo lee, nunca
 * confía en campos fuera de esta lista y nunca inventa un valor ausente.
 */
export class ExtractionDto {
  @ApiProperty({ enum: EXTRACTION_INTENTS })
  @IsIn(EXTRACTION_INTENTS)
  intent: ExtractionIntent;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  providerName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 160 })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  concept?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: [...obligationCategory.enumValues, null],
  })
  @IsOptional()
  @IsIn(obligationCategory.enumValues)
  category?: (typeof obligationCategory.enumValues)[number] | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  propertyName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  tenantAlias?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '85000.00' })
  @IsOptional()
  @IsMoneyAmount()
  amount?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'COP' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency debe ser un código ISO 4217' })
  currency?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 31 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  reminderDaysBefore?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 31,
    description: 'Día absoluto del aviso ("avísame el 7"); el backend lo convierte',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  reminderDay?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: [...recurrenceFrequency.enumValues, null],
  })
  @IsOptional()
  @IsIn(recurrenceFrequency.enumValues)
  frequency?: (typeof recurrenceFrequency.enumValues)[number] | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-11' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month debe ser YYYY-MM' })
  month?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-11-20' })
  @IsOptional()
  @IsCalendarDate()
  dueDate?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-12-01',
    description:
      'Fecha desde la que rige un arriendo ("a partir del 1 de diciembre de 2026"). Distinta de dueDate (vencimiento de una factura) y de dueDay (día de cobro)',
  })
  @IsOptional()
  @IsCalendarDate()
  startDate?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  missing?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  ambiguities?: string[];

  @ApiPropertyOptional({
    description: 'Evidencia textual por campo; no se reenvía al usuario tal cual',
  })
  @IsOptional()
  evidence?: unknown;

  @ApiPropertyOptional({
    default: false,
    description: 'R16: el mensaje intenta dar instrucciones al sistema',
  })
  @IsOptional()
  @IsBoolean()
  containsInstructions?: boolean;
}

export class ResolveCaseDto extends ClaimReferenceDto {
  @ApiProperty({ type: ExtractionDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ExtractionDto)
  extraction: ExtractionDto;
}

/** Continuación de una solicitud ambigua (A-7): qué hacer con la alternativa elegida. */
export type ResolveContinuation =
  | { intent: 'archive_obligation' }
  | {
      intent: 'update_obligation_schedule';
      params: {
        dueDay?: number;
        reminderDaysBefore?: number;
        reminderDay?: number;
        amount?: string;
      };
    };

export class ResolveChoiceDto {
  @ApiProperty({ example: 'a' })
  key: string;

  @ApiProperty({ example: 'Claro Hogar · Casa 17' })
  label: string;
}

export class ResolveResponseDto {
  @ApiProperty({ enum: RESOLVE_OUTCOMES })
  outcome: ResolveOutcome;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: '{ action, data } aplicable, o un objeto guiado { guided: {...} }',
  })
  proposedData: Record<string, unknown> | null;

  @ApiProperty({ type: [ResolveChoiceDto] })
  choices: ResolveChoiceDto[];

  @ApiPropertyOptional({
    type: Object,
    description:
      'Solo con needs_choice: operación y parámetros que el BACKEND (nunca la IA) continuará cuando la persona elija una alternativa',
  })
  continuation?: ResolveContinuation;

  @ApiProperty({ type: [String] })
  missing: string[];

  @ApiProperty({ type: [String] })
  warnings: string[];

  @ApiProperty({ example: 'Cambiar el vencimiento de Claro del día 7 al 15.' })
  summary: string;

  @ApiProperty({
    example:
      'Aprobar solo confirma. Después debes aplicar. No se cambia ningún pago ya registrado.',
  })
  consequences: string;
}
