import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsISO8601,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/authenticated-user.js';

/**
 * Campos de texto que acompañan a un adjunto PDF de Gmail en
 * `multipart/form-data`. NO incluye `ownerId`: el propietario sale únicamente
 * del vínculo configurado en el servidor para el buzón. Tampoco remitente ni
 * asunto, porque el backend no los necesita y no debe conservarlos.
 */
export class GmailAttachmentNoticeDto {
  @ApiProperty({
    example: 'facturas.hogar@example.com',
    description:
      'Buzón autorizado, tal como lo informa Gmail (users.getProfile)',
  })
  @IsEmail()
  @MaxLength(254)
  mailbox: string;

  @ApiProperty({ example: '18c2f5a9b0e4d1f2', description: 'Gmail message id' })
  @Matches(/^[A-Za-z0-9_-]{1,128}$/, {
    message: 'messageId no tiene el formato de un identificador de Gmail',
  })
  messageId: string;

  @ApiProperty({
    example: '1',
    description:
      'Gmail partId: identificador inmutable de la parte dentro del mensaje. No se usa attachmentId porque Gmail no garantiza que sea estable entre lecturas.',
  })
  @Matches(/^\d{1,4}(\.\d{1,4}){0,7}$/, {
    message: 'partId no tiene el formato de una parte de Gmail',
  })
  partId: string;

  @ApiProperty({ example: '2026-11-03T14:05:00Z' })
  @IsISO8601({ strict: true })
  receivedAt: string;

  @ApiPropertyOptional({ description: 'Ejecución del workflow (trazabilidad)' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  workflowRunId?: string;
}

/** Trabajador que figura como actor en la auditoría de la recepción. */
export const GMAIL_INTAKE_WORKER = 'gmail-intake';

/** Buzón normalizado: minúsculas y sin espacios (sin alias ni puntos de Gmail). */
export function normalizeMailbox(mailbox: string): string {
  return mailbox.trim().toLowerCase();
}

/**
 * Clave estable de deduplicación de un adjunto: buzón (resumido, para no
 * guardar la dirección en claro) + mensaje + parte. Repetir el mismo evento da
 * la misma clave; un correo nuevo con un archivo idéntico da otra. El nombre
 * del archivo y su contenido no intervienen.
 */
export function gmailDeduplicationKey(notice: {
  mailbox: string;
  messageId: string;
  partId: string;
}): string {
  const mailbox = createHash('sha256')
    .update(normalizeMailbox(notice.mailbox))
    .digest('hex')
    .slice(0, 32);
  return `gmail:${mailbox}:${notice.messageId}:${notice.partId}`;
}

/** Valor de `documents.external_message_id` para un adjunto de Gmail. */
export function gmailExternalId(notice: { messageId: string }): string {
  return `gmail:${notice.messageId}`;
}

/** Token de inyección del resolvedor de buzones vinculados. */
export const GMAIL_MAILBOX_RESOLVER = Symbol('GMAIL_MAILBOX_RESOLVER');

/** Relación verificable buzón → propietario. */
export interface GmailMailboxResolver {
  /** Cuenta activa propietaria del buzón, o `null` si no hay vínculo. */
  resolveOwner(mailbox: string): Promise<AuthenticatedUser | null>;
}
