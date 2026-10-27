import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsJsonObject } from '../../common/validators.js';
import {
  caseStatus,
  caseType,
  inputSource,
  jobStatus,
} from '../../database/schema/index.js';
import { CLAIM_TOKEN_PATTERN, WORKER_ID_PATTERN } from '../job-claims.js';

export const JOB_STATUSES = jobStatus.enumValues;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const MAX_CLAIM_BATCH = 10;
export const DEFAULT_CLAIM_BATCH = 5;
export const MIN_LEASE_SECONDS = 30;
export const MAX_LEASE_SECONDS = 900;
export const DEFAULT_LEASE_SECONDS = 300;
/** Tamaño máximo del resultado que un worker puede guardar en `result`. */
export const MAX_RESULT_BYTES = 16_384;

const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_.]*$/;

const workerIdMessage =
  'workerId debe tener 1 a 64 caracteres: letras, números, ".", "_" o "-"';
const claimTokenMessage = 'claimToken no tiene el formato esperado';

export class ClaimJobsDto {
  @ApiProperty({
    example: 'n8n-local-1',
    description: 'Identificador del worker (sin "#")',
  })
  @Matches(WORKER_ID_PATTERN, { message: workerIdMessage })
  workerId: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_CLAIM_BATCH,
    default: DEFAULT_CLAIM_BATCH,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CLAIM_BATCH)
  limit?: number;

  @ApiPropertyOptional({
    minimum: MIN_LEASE_SECONDS,
    maximum: MAX_LEASE_SECONDS,
    default: DEFAULT_LEASE_SECONDS,
    description: 'Duración del arrendamiento en segundos',
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_LEASE_SECONDS)
  @Max(MAX_LEASE_SECONDS)
  leaseSeconds?: number;

  @ApiPropertyOptional({
    type: [String],
    example: ['case.household_obligation'],
    description: 'Solo trabajos de estos tipos',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(JOB_TYPE_PATTERN, { each: true })
  @MaxLength(80, { each: true })
  jobTypes?: string[];
}

/** Prueba de reclamación: el token entregado al reclamar, nunca guardado en claro. */
export class ClaimProofDto {
  @ApiProperty({
    description: 'Token devuelto por /claim para esta reclamación',
  })
  @Matches(CLAIM_TOKEN_PATTERN, { message: claimTokenMessage })
  claimToken: string;
}

export class HeartbeatJobDto extends ClaimProofDto {
  @ApiPropertyOptional({
    minimum: MIN_LEASE_SECONDS,
    maximum: MAX_LEASE_SECONDS,
    default: DEFAULT_LEASE_SECONDS,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_LEASE_SECONDS)
  @Max(MAX_LEASE_SECONDS)
  leaseSeconds?: number;
}

export class CompleteJobDto extends ClaimProofDto {
  @ApiPropertyOptional({
    type: Object,
    description: `Resultado técnico de la automatización (máx. ${MAX_RESULT_BYTES} bytes). No modifica datos de negocio.`,
  })
  @IsOptional()
  @IsJsonObject(MAX_RESULT_BYTES)
  result?: Record<string, unknown>;
}

export class FailJobDto extends ClaimProofDto {
  @ApiProperty({
    maxLength: 2000,
    example: 'Gmail API timeout after 30s',
    description:
      'Descripción del error. Se sanea (sin tokens ni credenciales) y se trunca a 500 caracteres.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  error: string;

  @ApiPropertyOptional({
    default: true,
    description: '`false` marca el trabajo como fallido sin reintentos',
  })
  @IsOptional()
  @IsBoolean()
  retryable?: boolean;
}

export class JobCaseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  correlationId: string;

  @ApiProperty({ enum: caseType.enumValues })
  type: string;

  @ApiProperty({ enum: inputSource.enumValues })
  source: string;

  @ApiProperty({ enum: caseStatus.enumValues })
  status: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  obligationId: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  rentalId: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  contractId: string | null;
}

export class WorkflowJobDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'case.household_obligation' })
  jobType: string;

  @ApiProperty({ enum: JOB_STATUSES })
  status: JobStatus;

  @ApiProperty({ type: Object })
  payload: unknown;

  @ApiProperty()
  attempts: number;

  @ApiProperty()
  maxAttempts: number;

  @ApiProperty({ type: String, format: 'date-time' })
  availableAt: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Worker de la última reclamación',
  })
  workerId: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lockedUntil: Date | null;

  @ApiProperty({ type: Object, nullable: true })
  result: unknown;

  @ApiProperty({ type: String, nullable: true })
  lastError: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;

  @ApiProperty({ type: JobCaseDto })
  case: JobCaseDto;
}

export class ClaimedJobDto extends WorkflowJobDto {
  @ApiProperty({
    description:
      'Token de esta reclamación. Guárdalo solo en memoria del workflow; se exige en heartbeat, complete, fail y en las rutas internas de casos.',
  })
  claimToken: string;
}

export class ClaimResponseDto {
  @ApiProperty({ type: [ClaimedJobDto] })
  @Type(() => ClaimedJobDto)
  jobs: ClaimedJobDto[];
}
