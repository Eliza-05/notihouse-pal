import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ServiceRoute } from '../../auth/service-route.decorator.js';
import { CORRELATION_HEADER } from '../../common/correlation-id.decorator.js';
import { IngestionResponseDto } from '../dto/ingestion.dto.js';
import type { ReceivedFile } from '../file-policy.js';
import { IngestionService } from '../ingestion.service.js';
import { ReceiveUpload } from '../upload-receiver.js';
import {
  GMAIL_MAILBOX_RESOLVER,
  GmailAttachmentNoticeDto,
  type GmailMailboxResolver,
} from './gmail.contract.js';
import { Suspendable } from '../../kill-switch/kill-switch.guard.js';

export const GMAIL_NOT_LINKED =
  'El buzón no está vinculado a ningún usuario verificado: la ingesta de Gmail no está habilitada';

const UPLOAD_GMAIL_SCHEMA = {
  type: 'object',
  required: ['file', 'mailbox', 'messageId', 'partId', 'receivedAt'],
  properties: {
    file: { type: 'string', format: 'binary' },
    mailbox: { type: 'string', format: 'email' },
    messageId: { type: 'string' },
    partId: { type: 'string' },
    receivedAt: { type: 'string', format: 'date-time' },
    workflowRunId: { type: 'string' },
  },
};

/**
 * Recepción de adjuntos PDF de Gmail: solo con token de servicio (nunca un JWT
 * ni acceso público). El token por sí solo no decide el propietario: se
 * resuelve con el vínculo del buzón configurado en el servidor, y sin vínculo
 * no se guarda nada. Después sigue el mismo flujo que una carga manual, con
 * origen `gmail`: crea un trabajo `document.process` y nada más.
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
    private readonly ingestion: IngestionService,
  ) {}

  @Post('attachments')
  @Suspendable('gmail_ingestion')
  @UseInterceptors(ReceiveUpload('pdf'))
  @ApiOperation({
    summary: 'Registrar un adjunto PDF de un buzón de Gmail vinculado',
    description:
      'Valida el PDF, lo guarda de forma privada y crea documento, caso de origen `gmail` y trabajo `document.process`. Repetir buzón + mensaje + parte no crea nada nuevo.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: UPLOAD_GMAIL_SCHEMA })
  @ApiCreatedResponse({ type: IngestionResponseDto })
  @ApiOkResponse({
    type: IngestionResponseDto,
    description: 'Repetición idempotente del mismo mensaje y parte',
  })
  @ApiBadRequestResponse({
    description: 'Contrato inválido o campos no permitidos (p. ej. ownerId)',
  })
  @ApiForbiddenResponse({ description: 'Buzón sin vínculo verificable' })
  @ApiConflictResponse({
    description: 'El mismo mensaje y parte llegó con otro contenido',
  })
  @ApiPayloadTooLargeResponse({ description: 'Adjunto mayor que el máximo' })
  @ApiUnsupportedMediaTypeResponse({ description: 'No es un PDF admitido' })
  @ApiTooManyRequestsResponse({ description: 'Demasiadas subidas simultáneas' })
  @ApiServiceUnavailableResponse({
    description: 'Almacenamiento no disponible',
  })
  async receive(
    @UploadedFile() file: ReceivedFile | undefined,
    @Body() notice: GmailAttachmentNoticeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IngestionResponseDto> {
    const owner = await this.mailboxes.resolveOwner(notice.mailbox);
    if (!owner) throw new ForbiddenException(GMAIL_NOT_LINKED);
    const { created, result } = await this.ingestion.ingestGmail(
      owner,
      file,
      notice,
    );
    res.status(created ? 201 : 200);
    res.setHeader(CORRELATION_HEADER, result.correlationId);
    return result;
  }
}
