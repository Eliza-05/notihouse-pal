import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CorrelationId } from '../common/correlation-id.decorator.js';
import {
  ConfirmOccurrenceDto,
  CreateOccurrenceDto,
  ListOccurrencesQueryDto,
  OccurrencePageDto,
  OccurrenceResponseDto,
  UpdateOccurrenceDto,
} from './dto/occurrence.dto.js';
import { OccurrencesService } from './occurrences.service.js';

/** Períodos concretos de una obligación propia. Sin DELETE ni generación automática. */
@ApiTags('obligation occurrences')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@ApiNotFoundResponse({
  description: 'Obligación o período inexistente o de otro propietario',
})
@Controller('obligations/:id/occurrences')
export class OccurrencesController {
  constructor(private readonly service: OccurrencesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar períodos (ordenados por vencimiento)' })
  @ApiOkResponse({ type: OccurrencePageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) obligationId: string,
    @Query() query: ListOccurrencesQueryDto,
  ) {
    return this.service.list(user, obligationId, query);
  }

  @Get(':occurrenceId')
  @ApiOperation({ summary: 'Consultar un período' })
  @ApiOkResponse({ type: OccurrenceResponseDto })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) obligationId: string,
    @Param('occurrenceId', ParseUUIDPipe) occurrenceId: string,
  ) {
    return this.service.findOne(user, obligationId, occurrenceId);
  }

  @Post()
  @ApiOperation({ summary: 'Crear un período (siempre en estado pending)' })
  @ApiCreatedResponse({ type: OccurrenceResponseDto })
  @ApiBadRequestResponse({ description: 'Fechas o monto inválidos' })
  @ApiConflictResponse({
    description: 'Período duplicado u obligación archivada',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) obligationId: string,
    @Body() dto: CreateOccurrenceDto,
  ) {
    return this.service.create(user, correlationId, obligationId, dto);
  }

  @Patch(':occurrenceId')
  @ApiOperation({
    summary:
      'Editar un período pendiente o vencido (o anularlo con status=cancelled)',
  })
  @ApiOkResponse({ type: OccurrenceResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({
    description: 'Período confirmado/anulado o período duplicado',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) obligationId: string,
    @Param('occurrenceId', ParseUUIDPipe) occurrenceId: string,
    @Body() dto: UpdateOccurrenceDto,
  ) {
    return this.service.update(
      user,
      correlationId,
      obligationId,
      occurrenceId,
      dto,
    );
  }

  @Post(':occurrenceId/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirmación humana de pago o atención',
    description:
      'El usuario declara que pagó o atendió la obligación; NotiHouse-Pal no ejecuta pagos. ' +
      'Repetir la misma confirmación devuelve el período sin cambios; un resultado distinto o un período anulado devuelven 409.',
  })
  @ApiOkResponse({ type: OccurrenceResponseDto })
  @ApiBadRequestResponse({ description: 'Resultado inválido' })
  @ApiConflictResponse({
    description: 'Estado incompatible con la confirmación',
  })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) obligationId: string,
    @Param('occurrenceId', ParseUUIDPipe) occurrenceId: string,
    @Body() dto: ConfirmOccurrenceDto,
  ) {
    return this.service.confirm(
      user,
      correlationId,
      obligationId,
      occurrenceId,
      dto,
    );
  }
}
