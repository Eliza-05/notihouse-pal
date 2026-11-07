import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CorrelationId } from '../common/correlation-id.decorator.js';
import { AlertsService } from './alerts.service.js';
import {
  AlertPageDto,
  AlertResponseDto,
  AlertSummaryDto,
  ListAlertsQueryDto,
} from './dto/alert.dto.js';

/**
 * Alertas internas del usuario autenticado. Son avisos dentro de la
 * plataforma: no son notificaciones push, correos ni mensajes a terceros.
 */
@ApiTags('alerts')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('alerts')
export class AlertsController {
  constructor(private readonly service: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar alertas propias (más recientes primero)' })
  @ApiOkResponse({ type: AlertPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAlertsQueryDto,
  ) {
    return this.service.list(user, query);
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Resumen para la campana (contador de no leídas)',
    description:
      'Consulta ligera pensada para polling cada 60 s mientras el dashboard está visible. No modifica nada.',
  })
  @ApiOkResponse({ type: AlertSummaryDto })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.service.summary(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar una alerta propia' })
  @ApiOkResponse({ type: AlertResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Marcar como leída (idempotente)',
    description:
      'No confirma pagos ni cobros, no decide revisiones y no modifica contratos.',
  })
  @ApiOkResponse({ type: AlertResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.markRead(user, correlationId, id);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Descartar el aviso (idempotente)',
    description:
      'Solo oculta la alerta; el estado financiero o contractual del recurso no cambia.',
  })
  @ApiOkResponse({ type: AlertResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  @ApiConflictResponse({ description: 'La alerta ya fue resuelta' })
  dismiss(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.dismiss(user, correlationId, id);
  }
}
