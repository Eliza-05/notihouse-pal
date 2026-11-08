import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  type StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ServiceRoute } from '../auth/service-route.decorator.js';
import { CORRELATION_HEADER } from '../common/correlation-id.decorator.js';
import { CLAIM_TOKEN_HEADER } from '../integrations/workflow-jobs.controller.js';
import { CLAIM_TOKEN_PATTERN } from '../integrations/job-claims.js';
import { DocumentsService } from './documents.service.js';
import { privateDownload } from './download.js';
import {
  DocumentPageDto,
  DocumentResponseDto,
  IngestionResponseDto,
  ListDocumentsQueryDto,
  UPLOAD_DOCUMENT_SCHEMA,
  UPLOAD_VOICE_SCHEMA,
  UploadDocumentDto,
  UploadVoiceDto,
} from './dto/ingestion.dto.js';
import {
  CreateTextIngestionDto,
  TextIngestionResponseDto,
} from './dto/text-ingestion.dto.js';
import type { ReceivedFile } from './file-policy.js';
import { IngestionService } from './ingestion.service.js';
import { ReceiveUpload } from './upload-receiver.js';

export const JOB_ID_HEADER = 'x-job-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Carga autenticada de facturas PDF y notas de voz. */
@ApiTags('ingestion')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@ApiConsumes('multipart/form-data')
@ApiBadRequestResponse({
  description:
    'Archivo ausente o vacío, PDF mal formado, campos inválidos o multipart fuera de límites',
})
@ApiNotFoundResponse({ description: 'Entidad referida inexistente o ajena' })
@ApiConflictResponse({
  description: 'requestId reutilizado con otro archivo o datos',
})
@ApiPayloadTooLargeResponse({
  description: 'Archivo mayor que el máximo configurado',
})
@ApiUnsupportedMediaTypeResponse({
  description:
    'Extensión, tipo declarado y contenido no coinciden o no están admitidos',
})
@ApiTooManyRequestsResponse({ description: 'Demasiadas subidas simultáneas' })
@ApiServiceUnavailableResponse({ description: 'Almacenamiento no disponible' })
@Controller('ingestions')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('documents')
  @UseInterceptors(ReceiveUpload('pdf'))
  @ApiOperation({
    summary: 'Cargar una factura PDF y encolar su procesamiento',
    description:
      'Almacena el PDF de forma privada y crea, en una transacción, el documento, un caso de origen `document` y un trabajo `document.process`. No extrae ni interpreta el contenido.',
  })
  @ApiBody({ schema: UPLOAD_DOCUMENT_SCHEMA })
  @ApiCreatedResponse({ type: IngestionResponseDto })
  @ApiOkResponse({
    type: IngestionResponseDto,
    description: 'Repetición idempotente (mismo requestId)',
  })
  async uploadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: ReceivedFile | undefined,
    @Body() dto: UploadDocumentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IngestionResponseDto> {
    return respond(res, await this.ingestion.ingestDocument(user, file, dto));
  }

  @Post('voice')
  @UseInterceptors(ReceiveUpload('audio'))
  @ApiOperation({
    summary: 'Cargar una nota de voz y encolar su transcripción futura',
    description:
      'Almacena el audio de forma privada y crea el documento (`voice_note`), un caso de origen `voice` y un trabajo `voice.transcribe`. No transcribe ni interpreta nada.',
  })
  @ApiBody({ schema: UPLOAD_VOICE_SCHEMA })
  @ApiCreatedResponse({ type: IngestionResponseDto })
  @ApiOkResponse({
    type: IngestionResponseDto,
    description: 'Repetición idempotente (mismo requestId)',
  })
  async uploadVoice(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: ReceivedFile | undefined,
    @Body() dto: UploadVoiceDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IngestionResponseDto> {
    return respond(res, await this.ingestion.ingestVoice(user, file, dto));
  }

  @Post('text')
  @ApiConsumes('application/json')
  @ApiOperation({
    summary: 'Enviar un mensaje de texto al asistente',
    description:
      'Crea un caso (`form`) y un trabajo `text.interpret`. No interpreta nada aquí: ' +
      'no se llama a Gemini desde esta ruta. Se acepta aunque el kill switch limite ' +
      'el procesamiento (queda en cola).',
  })
  @ApiCreatedResponse({ type: TextIngestionResponseDto })
  @ApiOkResponse({
    type: TextIngestionResponseDto,
    description: 'Repetición idempotente (mismo requestId)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 3 mensajes propios en proceso',
  })
  async createText(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTextIngestionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TextIngestionResponseDto> {
    return respond(res, await this.ingestion.ingestText(user, dto));
  }
}

function respond<T extends { correlationId: string }>(
  res: Response,
  { created, result }: { created: boolean; result: T },
): T {
  res.status(created ? 201 : 200);
  res.setHeader(CORRELATION_HEADER, result.correlationId);
  return result;
}

/** Documentos privados del usuario autenticado. Sin DELETE ni reasignación. */
@ApiTags('documents')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar documentos propios (más recientes primero)',
  })
  @ApiOkResponse({ type: DocumentPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDocumentsQueryDto,
  ) {
    return this.documents.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Metadatos de un documento propio' })
  @ApiOkResponse({ type: DocumentResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documents.findOne(user, id);
  }

  @Get(':id/content')
  @ApiOperation({
    summary: 'Descargar el contenido (stream autenticado, como adjunto)',
  })
  @ApiProduces('application/pdf', 'audio/*')
  @ApiOkResponse({ description: 'Contenido del archivo' })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  async content(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return privateDownload(res, await this.documents.openForUser(user, id));
  }
}

/**
 * Lectura de archivos por el worker de n8n. Exige el token de servicio y la
 * reclamación vigente de un trabajo autorizado del mismo caso.
 */
@ApiTags('internal: documents')
@ServiceRoute()
@ApiUnauthorizedResponse({
  description: 'Token de servicio ausente o inválido',
})
@Controller('internal/documents')
export class InternalDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':id/content')
  @ApiOperation({
    summary: 'Contenido de un documento para el trabajo reclamado de su caso',
    description:
      'Leer el archivo no confirma pagos, no cambia estados financieros ni aprueba propuestas.',
  })
  @ApiHeader({ name: JOB_ID_HEADER, required: true })
  @ApiHeader({ name: CLAIM_TOKEN_HEADER, required: true })
  @ApiProduces('application/pdf', 'audio/*')
  @ApiOkResponse({ description: 'Contenido del archivo' })
  @ApiBadRequestResponse({ description: 'Faltan las cabeceras de reclamación' })
  @ApiNotFoundResponse({ description: 'Documento inexistente o de otro caso' })
  @ApiForbiddenResponse({
    description: 'Tipo de trabajo no autorizado para el documento',
  })
  async content(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(JOB_ID_HEADER) jobId: string | undefined,
    @Headers(CLAIM_TOKEN_HEADER) claimToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (
      !jobId ||
      !UUID.test(jobId) ||
      !claimToken ||
      !CLAIM_TOKEN_PATTERN.test(claimToken)
    ) {
      throw new BadRequestException(
        `Las cabeceras ${JOB_ID_HEADER} y ${CLAIM_TOKEN_HEADER} son obligatorias`,
      );
    }
    return privateDownload(
      res,
      await this.documents.openForWorker(id, jobId, claimToken),
    );
  }
}
