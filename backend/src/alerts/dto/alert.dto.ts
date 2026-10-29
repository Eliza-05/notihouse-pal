import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { QueryBoolean } from '../../common/dto-helpers.js';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { alertResolution } from '../../database/schema/index.js';
import { DUE_ITEM_KINDS } from '../../due-dates/due-date.rules.js';
import type { DueItemKind } from '../../due-dates/due-date.rules.js';
import { WORKER_ID_PATTERN } from '../../integrations/job-claims.js';
import {
  ALERT_SEVERITIES,
  ALERT_STATES,
  ALERT_TYPES,
  type AlertSeverity,
  type AlertState,
  type AlertType,
} from '../alert-rules.js';

export const ALERT_RESOLUTIONS = alertResolution.enumValues;
export const SORT_ORDERS = ['asc', 'desc'] as const;

export class ListAlertsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ALERT_STATES,
    description:
      '`active` = vigente (recurso aún abierto); `resolved` incluye alertas cuyo recurso ya se cerró',
  })
  @IsOptional()
  @IsIn(ALERT_STATES)
  state?: AlertState;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  read?: boolean;

  @ApiPropertyOptional({ enum: ALERT_TYPES })
  @IsOptional()
  @IsIn(ALERT_TYPES)
  type?: AlertType;

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES })
  @IsOptional()
  @IsIn(ALERT_SEVERITIES)
  severity?: AlertSeverity;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'true: solo alertas vigentes (equivale a state=active)',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  requiresAttention?: boolean;

  @ApiPropertyOptional({
    enum: SORT_ORDERS,
    default: 'desc',
    description: 'Orden por fecha de creación',
  })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  order: (typeof SORT_ORDERS)[number] = 'desc';
}

export class AlertResourceDto {
  @ApiProperty({ enum: DUE_ITEM_KINDS })
  type: DueItemKind;

  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: '/obligations/…/occurrences/…',
    description: 'Referencia de navegación del recurso',
  })
  path: string;
}

export class AlertResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ALERT_TYPES })
  type: AlertType;

  @ApiProperty({ enum: ALERT_SEVERITIES })
  severity: AlertSeverity;

  @ApiProperty({ example: 'Obligación próxima a vencer' })
  title: string;

  @ApiProperty()
  message: string;

  @ApiProperty({ example: '2026-11-18' })
  relevantDate: string;

  @ApiProperty({
    enum: ALERT_STATES,
    description: 'Estado efectivo (ver documentación)',
  })
  state: AlertState;

  @ApiProperty({ description: 'Vigente: el recurso sigue requiriendo acción' })
  requiresAttention: boolean;

  @ApiProperty()
  read: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dismissedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt: Date | null;

  @ApiProperty({ enum: ALERT_RESOLUTIONS, nullable: true })
  resolutionReason: (typeof ALERT_RESOLUTIONS)[number] | null;

  @ApiProperty({ type: AlertResourceDto })
  resource: AlertResourceDto;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class AlertPageDto extends PageMetaDto {
  @ApiProperty({ type: [AlertResponseDto] })
  items: AlertResponseDto[];
}

/** Cursor opaco devuelto por una evaluación incompleta. */
export const EVALUATION_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
export const MAX_EVALUATION_BATCH = 500;
export const MAX_EVALUATION_BATCHES = 100;

export class EvaluateAlertsDto {
  @ApiProperty({
    example: 'n8n-scheduler',
    description: 'Worker que ejecuta la evaluación',
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

export class EvaluateAlertsResponseDto {
  @ApiProperty({ example: '2026-10-29', description: 'Fecha de referencia' })
  evaluationDate: string;

  @ApiProperty({ example: 'America/Bogota' })
  timeZone: string;

  @ApiProperty({ format: 'uuid' })
  correlationId: string;

  @ApiProperty({ description: 'Registros y alertas examinados' })
  scanned: number;

  @ApiProperty()
  created: number;

  @ApiProperty({
    description: 'Alertas resueltas reactivadas por un cambio de fecha',
  })
  reactivated: number;

  @ApiProperty()
  resolved: number;

  @ApiProperty()
  unchanged: number;

  @ApiProperty({
    description: 'false si quedó trabajo pendiente (usar nextCursor)',
  })
  complete: boolean;

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}
