import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ServiceRoute } from '../auth/service-route.decorator.js';
import { CorrelationId } from '../common/correlation-id.decorator.js';
import { AlertEvaluationService } from './alert-evaluation.service.js';
import {
  EvaluateAlertsDto,
  EvaluateAlertsResponseDto,
} from './dto/alert.dto.js';

/** Evaluación determinística de alertas, para un workflow programado. */
@ApiTags('internal: alerts')
@ServiceRoute()
@ApiUnauthorizedResponse({
  description: 'Token de servicio ausente o inválido',
})
@Controller('internal/alerts')
export class InternalAlertsController {
  constructor(private readonly service: AlertEvaluationService) {}

  @Post('evaluate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Evaluar vencimientos y sincronizar alertas internas',
    description:
      'Fecha de referencia: hoy en la zona horaria configurada. Crea, escala o resuelve alertas por lotes; ' +
      'repetir la evaluación no duplica alertas. Nunca modifica pagos, cobros, contratos ni revisiones, ' +
      'y no envía notificaciones push ni correos.',
  })
  @ApiOkResponse({ type: EvaluateAlertsResponseDto })
  @ApiBadRequestResponse({ description: 'Parámetros o cursor inválidos' })
  evaluate(
    @CorrelationId() correlationId: string,
    @Body() dto: EvaluateAlertsDto,
  ): Promise<EvaluateAlertsResponseDto> {
    return this.service.evaluate(correlationId, dto);
  }
}
