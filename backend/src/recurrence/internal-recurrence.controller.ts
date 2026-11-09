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
import { Suspendable } from '../kill-switch/kill-switch.guard.js';
import {
  GenerateRecurrenceDto,
  GenerateRecurrenceResponseDto,
} from './dto/recurrence.dto.js';
import { RecurrenceService } from './recurrence.service.js';

/** Generación determinística de períodos y cobros, para un workflow programado. */
@ApiTags('internal: recurrence')
@ServiceRoute()
@ApiUnauthorizedResponse({
  description: 'Token de servicio ausente o inválido',
})
@Controller('internal/recurrence')
export class InternalRecurrenceController {
  constructor(private readonly service: RecurrenceService) {}

  @Post('generate')
  @Suspendable('recurrence_generation')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generar el ciclo actual y el siguiente de períodos y cobros',
    description:
      'Solo obligaciones y arriendos activos con autoGenerate = true. Idempotente: repetir no duplica. ' +
      'Nunca modifica históricos ni inventa montos. Sin Gemini.',
  })
  @ApiOkResponse({ type: GenerateRecurrenceResponseDto })
  @ApiBadRequestResponse({ description: 'Parámetros o cursor inválidos' })
  generate(
    @CorrelationId() correlationId: string,
    @Body() dto: GenerateRecurrenceDto,
  ): Promise<GenerateRecurrenceResponseDto> {
    return this.service.generate(correlationId, dto);
  }
}
