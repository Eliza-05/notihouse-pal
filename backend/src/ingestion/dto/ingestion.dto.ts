import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { CASE_TYPES, type CaseType } from '../../cases/dto/case.dto.js';
import { documentType, inputSource } from '../../database/schema/index.js';

/** Tipos documentales que admite la carga manual de PDF. */
export const PDF_DOCUMENT_TYPES = [
  'invoice',
  'payment_receipt',
  'contract',
] as const;
export type PdfDocumentType = (typeof PDF_DOCUMENT_TYPES)[number];

/** Tipo de caso según el documento: los contratos van a revisión contractual. */
export const CASE_TYPE_FOR_DOCUMENT: Record<PdfDocumentType, CaseType> = {
  invoice: 'household_obligation',
  payment_receipt: 'household_obligation',
  contract: 'contract_review',
};

/** Trabajos que crea la ingesta; ningún cliente elige el tipo. */
export const INGESTION_JOB_TYPES = {
  document: 'document.process',
  voice: 'voice.transcribe',
} as const;

const fileSchema = {
  file: { type: 'string', format: 'binary' },
} as const;

/**
 * Campos de texto del formulario de carga de PDF (`multipart/form-data`).
 * El propietario sale del JWT; no hay `ownerId`, `caseId` ni rutas.
 * `propertyId` no se admite: ni `cases` ni `documents` tienen esa columna.
 */
export class UploadDocumentDto {
  @ApiPropertyOptional({ enum: PDF_DOCUMENT_TYPES, default: 'invoice' })
  @IsOptional()
  @IsIn(PDF_DOCUMENT_TYPES)
  documentType?: PdfDocumentType;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligación propia (facturas y comprobantes)',
  })
  @IsOptional()
  @IsUUID()
  obligationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Contrato propio (documentType=contract)',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Clave de idempotencia del cliente: repetir la carga con la misma clave devuelve el registro existente (200)',
  })
  @IsOptional()
  @IsUUID()
  requestId?: string;
}

/** Campos de texto del formulario de nota de voz. */
export class UploadVoiceDto {
  @ApiPropertyOptional({ enum: CASE_TYPES, default: 'household_obligation' })
  @IsOptional()
  @IsIn(CASE_TYPES)
  caseType?: CaseType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  obligationId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  rentalId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  requestId?: string;
}

export const UPLOAD_DOCUMENT_SCHEMA = {
  type: 'object',
  required: ['file'],
  properties: {
    ...fileSchema,
    documentType: { type: 'string', enum: [...PDF_DOCUMENT_TYPES] },
    obligationId: { type: 'string', format: 'uuid' },
    contractId: { type: 'string', format: 'uuid' },
    requestId: { type: 'string', format: 'uuid' },
  },
};

export const UPLOAD_VOICE_SCHEMA = {
  type: 'object',
  required: ['file'],
  properties: {
    ...fileSchema,
    caseType: { type: 'string', enum: [...CASE_TYPES] },
    obligationId: { type: 'string', format: 'uuid' },
    rentalId: { type: 'string', format: 'uuid' },
    contractId: { type: 'string', format: 'uuid' },
    requestId: { type: 'string', format: 'uuid' },
  },
};

export class IngestionJobDto {
  @ApiProperty({ example: 'document.process' })
  type: string;

  @ApiProperty({ example: 'pending', description: 'Estado actual del trabajo' })
  status: string;
}

/**
 * Resultado de una ingesta: el archivo se recibió, se almacenó y quedó
 * encolado. No significa que se haya leído, transcrito ni interpretado.
 */
export class IngestionResponseDto {
  @ApiProperty({ format: 'uuid' })
  documentId: string;

  @ApiProperty({ format: 'uuid' })
  caseId: string;

  @ApiProperty({ format: 'uuid' })
  correlationId: string;

  @ApiProperty({ example: 'received', description: 'Estado del caso' })
  caseStatus: string;

  @ApiProperty({ enum: ['document', 'voice'] })
  source: string;

  @ApiProperty({ enum: documentType.enumValues })
  documentType: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType: string;

  @ApiProperty({ example: 'e3b0c442…', description: 'SHA-256 del contenido' })
  sha256: string;

  @ApiProperty({ example: 12345 })
  sizeBytes: number;

  @ApiProperty({ type: IngestionJobDto })
  job: IngestionJobDto;

  @ApiProperty({
    enum: ['pending'],
    description: 'El contenido aún no ha sido procesado (sin OCR, IA ni STT)',
  })
  processing: 'pending';

  @ApiProperty({
    description:
      'true si el usuario ya había cargado un archivo con el mismo contenido (no se reutiliza)',
  })
  duplicateContent: boolean;
}

export class ListDocumentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: documentType.enumValues })
  @IsOptional()
  @IsIn(documentType.enumValues)
  type?: (typeof documentType.enumValues)[number];

  @ApiPropertyOptional({ enum: inputSource.enumValues })
  @IsOptional()
  @IsIn(inputSource.enumValues)
  source?: (typeof inputSource.enumValues)[number];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  caseId?: string;
}

/** Metadatos de un documento propio. Sin clave de almacenamiento ni rutas. */
export class DocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  caseId: string | null;

  @ApiProperty({ enum: documentType.enumValues })
  type: string;

  @ApiProperty({ enum: inputSource.enumValues })
  source: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'factura-noviembre.pdf',
  })
  fileName: string | null;

  @ApiProperty({ type: String, nullable: true })
  sha256: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class DocumentPageDto extends PageMetaDto {
  @ApiProperty({ type: [DocumentResponseDto] })
  items: DocumentResponseDto[];
}
