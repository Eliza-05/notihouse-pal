import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  PayloadTooLargeException,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ServiceRoute } from '../../auth/service-route.decorator.js';
import {
  GMAIL_MAILBOX_RESOLVER,
  GmailAttachmentNoticeDto,
  type GmailMailboxResolver,
  MAX_GMAIL_ATTACHMENT_BYTES,
} from './gmail.contract.js';

export const GMAIL_NOT_LINKED =
  'El buzón no está vinculado a ningún usuario verificado: la ingesta de Gmail no está habilitada';

/**
 * Recepción de adjuntos de Gmail (contrato preparado, NO operativo).
 * Sin OAuth ni vínculos verificados, todo buzón se rechaza con 403 antes de
 * crear nada; el token de servicio por sí solo nunca decide el propietario.
 */
@ApiTags('internal: gmail')
@ServiceRoute()
@ApiUnauthorizedResponse({
  description: 'Token de servicio ausente o inválido',
})
@Controller('internal/gmail')
export class GmailIngestionController {
  constructor(
    @Inject(GMAIL_MAILBOX_RESOLVER)
    private readonly mailboxes: GmailMailboxResolver,
  ) {}

  @Post('attachments')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Notificar un adjunto PDF de Gmail (no operativo: requiere OAuth)',
    description:
      'Valida el contrato y exige un buzón vinculado y verificado. Mientras no exista la integración OAuth, responde 403.',
  })
  @ApiBadRequestResponse({
    description: 'Contrato inválido o campos no permitidos (p. ej. ownerId)',
  })
  @ApiForbiddenResponse({ description: 'Buzón sin vínculo verificable' })
  async receive(@Body() notice: GmailAttachmentNoticeDto): Promise<never> {
    if (notice.sizeBytes > MAX_GMAIL_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException('El adjunto supera el tamaño máximo');
    }
    const owner = await this.mailboxes.resolveOwner(notice.mailbox);
    if (!owner) throw new ForbiddenException(GMAIL_NOT_LINKED);
    // Inalcanzable con NoVerifiedMailboxes. Cuando exista OAuth, aquí se
    // reutilizará la ingesta de documentos (origen `gmail`, deduplicando con
    // gmailDeduplicationKey); hasta entonces no se crea ningún registro.
    throw new ForbiddenException(GMAIL_NOT_LINKED);
  }
}
