import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ServiceRoute } from '../auth/service-route.decorator.js';
import {
  ClaimJobsDto,
  ClaimResponseDto,
  CompleteJobDto,
  FailJobDto,
  HeartbeatJobDto,
  WorkflowJobDto,
} from './dto/workflow-job.dto.js';
import { CLAIM_TOKEN_PATTERN } from './job-claims.js';
import { WorkflowJobsService } from './workflow-jobs.service.js';

export const CLAIM_TOKEN_HEADER = 'x-claim-token';

/**
 * Cola de trabajos para n8n (polling). Solo el token de servicio; un JWT de
 * usuario se rechaza. No hay creación libre de trabajos: los crea el backend
 * al registrar un caso o una decisión HITL.
 */
@ApiTags('internal: workflow jobs')
@ServiceRoute()
@ApiUnauthorizedResponse({
  description: 'Token de servicio ausente o inválido',
})
@Controller('internal/workflow-jobs')
export class WorkflowJobsController {
  constructor(private readonly service: WorkflowJobsService) {}

  @Post('claim')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reclamar un lote de trabajos disponibles',
    description:
      'Devuelve solo los trabajos realmente reclamados (puede ser una lista vacía), cada uno con su claimToken.',
  })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiBadRequestResponse({ description: 'Parámetros inválidos' })
  async claim(@Body() dto: ClaimJobsDto): Promise<ClaimResponseDto> {
    return { jobs: await this.service.claim(dto) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar un trabajo con reclamación vigente' })
  @ApiHeader({ name: CLAIM_TOKEN_HEADER, required: true })
  @ApiOkResponse({ type: WorkflowJobDto })
  @ApiNotFoundResponse({ description: 'Trabajo inexistente' })
  @ApiConflictResponse({ description: 'Reclamación inválida o vencida' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(CLAIM_TOKEN_HEADER) claimToken: string | undefined,
  ) {
    if (!claimToken || !CLAIM_TOKEN_PATTERN.test(claimToken)) {
      throw new BadRequestException(
        `La cabecera ${CLAIM_TOKEN_HEADER} es obligatoria`,
      );
    }
    return this.service.findClaimed(id, claimToken);
  }

  @Post(':id/heartbeat')
  @HttpCode(200)
  @ApiOperation({ summary: 'Renovar el arrendamiento de la reclamación' })
  @ApiOkResponse({ type: WorkflowJobDto })
  @ApiConflictResponse({ description: 'Reclamación inválida o vencida' })
  heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HeartbeatJobDto,
  ) {
    return this.service.heartbeat(id, dto);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Finalizar el trabajo (idempotente para la misma reclamación)',
    description:
      'Solo registra que terminó la automatización. No confirma pagos ni cobros, no renueva contratos ni aprueba propuestas.',
  })
  @ApiOkResponse({ type: WorkflowJobDto })
  @ApiConflictResponse({
    description: 'Reclamación inválida, reemplazada o vencida',
  })
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteJobDto,
  ) {
    return this.service.complete(id, dto);
  }

  @Post(':id/fail')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Registrar un fallo (reintento con espera o fallo definitivo)',
  })
  @ApiOkResponse({ type: WorkflowJobDto })
  @ApiConflictResponse({
    description: 'Reclamación inválida, reemplazada o vencida',
  })
  fail(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FailJobDto) {
    return this.service.fail(id, dto);
  }
}
