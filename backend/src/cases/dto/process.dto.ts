import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import { Trim } from '../../common/dto-helpers.js';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { IsJsonObject } from '../../common/validators.js';
import {
  hitlDecisionType,
  hitlStatus,
  proposalReviewStatus,
  proposalSource,
} from '../../database/schema/index.js';
import {
  CLAIM_TOKEN_PATTERN,
  WORKER_ID_PATTERN,
} from '../../integrations/job-claims.js';

export const PROPOSAL_REVIEW_STATUSES = proposalReviewStatus.enumValues;
/** El servicio solo registra propuestas automáticas; `user` queda para la app. */
export const SERVICE_PROPOSAL_SOURCES = ['llm', 'ocr', 'stt'] as const;
export const HITL_DECISION_TYPES = hitlDecisionType.enumValues;
export const HITL_STATUSES = hitlStatus.enumValues;
export const HITL_OUTCOMES = ['approved', 'rejected'] as const;
export type HitlOutcome = (typeof HITL_OUTCOMES)[number];

export const MAX_PROPOSED_DATA_BYTES = 16_384;
export const MAX_EVIDENCE_BYTES = 8_192;
export const MAX_HITL_CONTEXT_BYTES = 4_096;

const CONFIDENCE_PATTERN = /^(0(\.\d{1,3})?|1(\.0{1,3})?)$/;
const CHOICE_KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;

/**
 * Referencia a la reclamación vigente de un trabajo del mismo caso. Toda
 * escritura interna sobre un caso la exige: el servicio solo actúa sobre
 * casos que está procesando en ese momento.
 */
export class ClaimReferenceDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  jobId: string;

  @ApiProperty({ description: 'claimToken devuelto por /claim' })
  @Matches(CLAIM_TOKEN_PATTERN, {
    message: 'claimToken no tiene el formato esperado',
  })
  claimToken: string;
}

// ---------------------------------------------------------------- propuestas

export class CreateProposalDto extends ClaimReferenceDto {
  @ApiProperty({ enum: SERVICE_PROPOSAL_SOURCES })
  @IsIn(SERVICE_PROPOSAL_SOURCES)
  source: (typeof SERVICE_PROPOSAL_SOURCES)[number];

  @ApiProperty({
    type: Object,
    description: `Datos interpretados (máx. ${MAX_PROPOSED_DATA_BYTES} bytes). Nunca se aplican directamente.`,
    example: { amount: '145000.00', dueDate: '2026-11-18' },
  })
  @IsJsonObject(MAX_PROPOSED_DATA_BYTES)
  proposedData: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    description: `Evidencia mínima: fragmento, página o campo de origen (máx. ${MAX_EVIDENCE_BYTES} bytes)`,
  })
  @IsOptional()
  @IsJsonObject(MAX_EVIDENCE_BYTES)
  evidence?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: String,
    example: '0.870',
    description: 'Confianza entre 0 y 1 como texto, máx. 3 decimales',
  })
  @IsOptional()
  @Matches(CONFIDENCE_PATTERN, {
    message: 'confidence debe ser un decimal entre 0 y 1 como texto',
  })
  confidence?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Documento de origen del mismo propietario',
  })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

export class ListProposalsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PROPOSAL_REVIEW_STATUSES })
  @IsOptional()
  @IsIn(PROPOSAL_REVIEW_STATUSES)
  reviewStatus?: (typeof PROPOSAL_REVIEW_STATUSES)[number];
}

export class ProposalResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  caseId: string;

  @ApiProperty({ example: 1 })
  version: number;

  @ApiProperty({ enum: proposalSource.enumValues })
  source: string;

  @ApiProperty({ type: Object })
  proposedData: unknown;

  @ApiProperty({ type: Object, nullable: true })
  evidence: unknown;

  @ApiProperty({ type: String, nullable: true, example: '0.870' })
  confidence: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  documentId: string | null;

  @ApiProperty({ enum: PROPOSAL_REVIEW_STATUSES })
  reviewStatus: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reviewedBy: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Fecha en que la propuesta se aplicó a los datos de negocio; null si aún no se aplicó. Solo aparece en lecturas.',
  })
  appliedAt?: string | null;
}

export class ProposalPageDto extends PageMetaDto {
  @ApiProperty({ type: [ProposalResponseDto] })
  items: ProposalResponseDto[];
}

// ---------------------------------------------------------------------- HITL

export class HitlChoiceDto {
  @ApiProperty({ example: 'amount_a', pattern: CHOICE_KEY_PATTERN.source })
  @Matches(CHOICE_KEY_PATTERN, {
    message: 'key debe tener 1 a 40 caracteres: a-z, 0-9, "_" o "-"',
  })
  key: string;

  @ApiProperty({ example: 'Total a pagar: $145.000', maxLength: 200 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;
}

/** Información mínima para que el usuario decida. */
export class HitlOptionsDto {
  @ApiProperty({
    maxLength: 500,
    example: 'La factura muestra dos valores posibles; confirma el correcto',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  summary: string;

  @ApiPropertyOptional({
    type: [HitlChoiceDto],
    description:
      'Alternativas; si existen, aprobar exige elegir una (`choice`)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => HitlChoiceDto)
  choices?: HitlChoiceDto[];

  @ApiPropertyOptional({
    type: Object,
    description: `Contexto adicional (máx. ${MAX_HITL_CONTEXT_BYTES} bytes)`,
  })
  @IsOptional()
  @IsJsonObject(MAX_HITL_CONTEXT_BYTES)
  context?: Record<string, unknown>;
}

export class CreateHitlRequestDto extends ClaimReferenceDto {
  @ApiProperty({ enum: HITL_DECISION_TYPES })
  @IsIn(HITL_DECISION_TYPES)
  decisionType: (typeof HITL_DECISION_TYPES)[number];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Propuesta pendiente del mismo caso que se somete a revisión',
  })
  @IsOptional()
  @IsUUID()
  proposalId?: string;

  @ApiProperty({ type: HitlOptionsDto })
  @ValidateNested()
  @Type(() => HitlOptionsDto)
  options: HitlOptionsDto;
}

/** Decisión explícita del usuario. El servidor asigna actor y hora. */
export class DecideHitlDto {
  @ApiProperty({ enum: HITL_OUTCOMES })
  @IsIn(HITL_OUTCOMES)
  decision: HitlOutcome;

  @ApiPropertyOptional({
    example: 'amount_a',
    description:
      'Clave de la alternativa elegida (obligatoria al aprobar si hay alternativas)',
  })
  @IsOptional()
  @Matches(CHOICE_KEY_PATTERN, { message: 'choice no es una clave válida' })
  choice?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @Trim()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  comment?: string;
}

export class ListHitlQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: HITL_STATUSES })
  @IsOptional()
  @IsIn(HITL_STATUSES)
  status?: (typeof HITL_STATUSES)[number];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  caseId?: string;
}

export class ExpireHitlDto {
  @ApiProperty({
    example: 'n8n-scheduler',
    description: 'Worker que ejecuta el barrido',
  })
  @Matches(WORKER_ID_PATTERN, {
    message:
      'workerId debe tener 1 a 64 caracteres: letras, números, ".", "_" o "-"',
  })
  workerId: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class HitlResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  caseId: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  proposalId: string | null;

  @ApiProperty({ enum: HITL_DECISION_TYPES })
  decisionType: string;

  @ApiProperty({ enum: HITL_STATUSES })
  status: string;

  @ApiProperty({
    description:
      'true si sigue `pending` pero ya pasó `dueAt`: no puede aprobarse',
  })
  overdue: boolean;

  @ApiProperty({ type: Object })
  options: unknown;

  @ApiProperty({ type: Object, nullable: true })
  decision: unknown;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  dueAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class HitlDetailDto extends HitlResponseDto {
  @ApiProperty({ type: ProposalResponseDto, nullable: true })
  proposal: ProposalResponseDto | null;
}

export class HitlPageDto extends PageMetaDto {
  @ApiProperty({ type: [HitlResponseDto] })
  items: HitlResponseDto[];
}

export class FailCaseDto extends ClaimReferenceDto {
  @ApiProperty({
    maxLength: 500,
    example: 'No se pudo interpretar el documento',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class ExpireHitlResponseDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  expired: string[];
}
