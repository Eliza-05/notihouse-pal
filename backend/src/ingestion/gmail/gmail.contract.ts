import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { createHash } from 'node:crypto';
import { UPLOAD_LIMITS } from '../../config/env.validation.js';

/**
 * Contrato que usará el workflow de Gmail (fase posterior) para notificar un
 * adjunto PDF detectado. NO incluye `ownerId`: el propietario solo podrá
 * determinarse a partir de un buzón vinculado y verificado por OAuth.
 */
export class GmailAttachmentNoticeDto {
  @ApiProperty({
    example: 'facturas.hogar@example.com',
    description: 'Buzón autorizado del que proviene el mensaje',
  })
  @IsEmail()
  @MaxLength(254)
  mailbox: string;

  @ApiProperty({ example: '18c2f5a9b0e4d1f2', description: 'Gmail message id' })
  @Matches(/^[A-Za-z0-9_-]{1,128}$/, {
    message: 'messageId no tiene el formato de un identificador de Gmail',
  })
  messageId: string;

  @ApiProperty({ description: 'Gmail attachment id' })
  @Matches(/^[A-Za-z0-9_-]{1,1024}$/, {
    message: 'attachmentId no tiene el formato de un identificador de Gmail',
  })
  attachmentId: string;

  @ApiProperty({ example: '2026-11-03T14:05:00Z' })
  @IsISO8601({ strict: true })
  receivedAt: string;

  @ApiProperty({ example: 'facturacion@proveedor.example', maxLength: 320 })
  @IsString()
  @MaxLength(320)
  from: string;

  @ApiProperty({ example: 'Factura de noviembre', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  subject: string;

  @ApiProperty({ example: 'factura.pdf', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  fileName: string;

  @ApiProperty({ enum: ['application/pdf'] })
  @IsIn(['application/pdf'])
  mimeType: 'application/pdf';

  @ApiProperty({ example: 'e3b0c442…', description: 'SHA-256 del adjunto' })
  @Matches(/^[0-9a-f]{64}$/, {
    message: 'sha256 debe ser hexadecimal en minúsculas',
  })
  sha256: string;

  @ApiProperty({ example: 48213 })
  @IsInt()
  @Min(1)
  sizeBytes: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Trazabilidad del workflow',
  })
  @IsOptional()
  @Matches(/^[0-9a-f-]{36}$/i)
  workflowRunId?: string;
}

/** Tamaño máximo de un adjunto, igual al de un PDF cargado a mano (valor inicial). */
export const MAX_GMAIL_ATTACHMENT_BYTES = UPLOAD_LIMITS.pdf.default;

/** Buzón normalizado: minúsculas y sin espacios (sin alias ni puntos de Gmail). */
export function normalizeMailbox(mailbox: string): string {
  return mailbox.trim().toLowerCase();
}

/**
 * Clave estable de deduplicación de un adjunto: buzón (resumido, para no
 * guardar la dirección en claro) + mensaje + adjunto. El mismo adjunto
 * recibido por dos buzones distintos son dos registros distintos; el nombre
 * del archivo no interviene.
 */
export function gmailDeduplicationKey(notice: {
  mailbox: string;
  messageId: string;
  attachmentId: string;
}): string {
  const mailbox = createHash('sha256')
    .update(normalizeMailbox(notice.mailbox))
    .digest('hex')
    .slice(0, 32);
  const attachment = createHash('sha256')
    .update(notice.attachmentId)
    .digest('hex')
    .slice(0, 32);
  return `gmail:${mailbox}:${notice.messageId}:${attachment}`;
}

/** Valor de `documents.external_message_id` para un adjunto de Gmail. */
export function gmailExternalId(notice: { messageId: string }): string {
  return `gmail:${notice.messageId}`;
}

/** Token de inyección del resolvedor de buzones vinculados. */
export const GMAIL_MAILBOX_RESOLVER = Symbol('GMAIL_MAILBOX_RESOLVER');

/**
 * Relación verificable buzón → usuario. La implementación real necesitará
 * OAuth de Google y una tabla de vínculos (fase posterior).
 */
export interface GmailMailboxResolver {
  /** Perfil propietario del buzón, o `null` si no hay vínculo verificado. */
  resolveOwner(mailbox: string): Promise<string | null>;
}

/**
 * Implementación actual: NO existe ningún vínculo verificado, porque OAuth no
 * está implementado. Ningún buzón resuelve a un usuario, así que la ingesta
 * de Gmail queda protegida y no operativa.
 */
export class NoVerifiedMailboxes implements GmailMailboxResolver {
  resolveOwner(): Promise<string | null> {
    return Promise.resolve(null);
  }
}
