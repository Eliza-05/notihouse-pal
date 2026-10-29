import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { AlertResourceDto } from '../../alerts/dto/alert.dto.js';
import {
  ATTENTION_PRIORITIES,
  DUE_CONDITIONS,
  DUE_ITEM_KINDS,
  type DueItemKind,
  HITL_CONDITIONS,
} from '../../due-dates/due-date.rules.js';

export const SUGGESTED_ACTIONS = [
  'confirm_payment',
  'confirm_receipt',
  'review_contract',
  'decide_review',
  'view_review',
] as const;
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

export const ATTENTION_CONDITIONS = [
  ...new Set([...DUE_CONDITIONS, ...HITL_CONDITIONS]),
].filter((c) => c !== 'scheduled' && c !== 'resolved');
export type AttentionCondition =
  'upcoming' | 'due_today' | 'overdue' | 'pending' | 'due_soon';

export class AttentionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DUE_ITEM_KINDS })
  @IsOptional()
  @IsIn(DUE_ITEM_KINDS)
  kind?: DueItemKind;
}

export class AttentionAlertDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  read: boolean;
}

export class AttentionItemDto {
  @ApiProperty({ enum: DUE_ITEM_KINDS })
  kind: DueItemKind;

  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Energía — Empresa de energía' })
  title: string;

  @ApiProperty({ example: 'Vence en 3 días' })
  description: string;

  @ApiProperty({
    example: '2026-11-18',
    description: 'Fecha de calendario relevante (zona horaria del MVP)',
  })
  relevantDate: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Fecha límite con hora (solo revisiones HITL)',
  })
  dueAt: Date | null;

  @ApiProperty({ description: 'Estado almacenado del recurso' })
  status: string;

  @ApiProperty({ enum: ATTENTION_CONDITIONS })
  condition: AttentionCondition;

  @ApiProperty({
    enum: [...new Set(Object.values(ATTENTION_PRIORITIES))],
    description: 'Prioridad determinística (1 = más urgente)',
  })
  priority: number;

  @ApiProperty({ description: 'Días hasta la fecha (negativo si pasó)' })
  daysUntil: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '145000.00',
    description: 'Valor esperado del registro (no es un pago realizado)',
  })
  amount: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'COP' })
  currency: string | null;

  @ApiProperty({ enum: SUGGESTED_ACTIONS })
  suggestedAction: SuggestedAction;

  @ApiProperty({ type: AlertResourceDto })
  resource: AlertResourceDto;

  @ApiProperty({
    type: AttentionAlertDto,
    nullable: true,
    description: 'Alerta interna vigente del recurso, si existe',
  })
  alert: AttentionAlertDto | null;
}

export class AttentionPageDto extends PageMetaDto {
  @ApiProperty({ example: '2026-10-29' })
  referenceDate: string;

  @ApiProperty({ type: [AttentionItemDto] })
  items: AttentionItemDto[];
}
