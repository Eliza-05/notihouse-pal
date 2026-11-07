import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ServiceRoute } from '../auth/service-route.decorator.js';
import { CaseProcessService } from './case-process.service.js';
import { CaseResponseDto } from './dto/case.dto.js';
import {
  ClaimReferenceDto,
  CreateHitlRequestDto,
  CreateProposalDto,
  ExpireHitlDto,
  ExpireHitlResponseDto,
  FailCaseDto,
  HitlResponseDto,
  ProposalResponseDto,
} from './dto/process.dto.js';
import { HitlService } from './hitl.service.js';
import { Suspendable } from '../kill-switch/kill-switch.guard.js';

/**
 * Escrituras del servicio de automatización sobre casos. Cada operación
 * exige la reclamación vigente de un trabajo del mismo caso.
 */
@ApiTags('internal: cases')
@ServiceRoute()
@ApiUnauthorizedResponse({
  description: 'Token de servicio ausente o inválido',
})
@ApiNotFoundResponse({
  description: 'Caso o trabajo inexistente, o no relacionados',
})
@Controller('internal/cases/:id')
export class InternalCasesController {
  constructor(private readonly service: CaseProcessService) {}

  @Post('proposals')
  @ApiOperation({
    summary: 'Registrar una propuesta (nueva versión pending_review)',
    description:
      'Guardar una propuesta no la aprueba ni modifica obligaciones, cobros o contratos. Un reintento idéntico devuelve 200 con la versión existente.',
  })
  @ApiCreatedResponse({ type: ProposalResponseDto })
  @ApiOkResponse({
    type: ProposalResponseDto,
    description: 'Reintento idéntico',
  })
  @ApiBadRequestResponse({ description: 'Estructura o tamaño inválidos' })
  @ApiConflictResponse({ description: 'Reclamación inválida o caso cerrado' })
  async createProposal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProposalDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProposalResponseDto> {
    const { created, proposal } = await this.service.createProposal(id, dto);
    res.status(created ? 201 : 200);
    return proposal;
  }

  @Post('hitl-requests')
  @ApiOperation({
    summary: 'Solicitar una revisión humana (SLA de 24 horas)',
    description:
      'Se asigna al propietario del caso; el caso pasa a awaiting_human. Un reintento idéntico devuelve 200.',
  })
  @ApiCreatedResponse({ type: HitlResponseDto })
  @ApiOkResponse({ type: HitlResponseDto, description: 'Reintento idéntico' })
  @ApiBadRequestResponse({ description: 'Estructura inválida' })
  @ApiConflictResponse({
    description: 'Reclamación inválida, caso cerrado o propuesta no pendiente',
  })
  async createHitlRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateHitlRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HitlResponseDto> {
    const { created, request } = await this.service.createHitlRequest(id, dto);
    res.status(created ? 201 : 200);
    return request;
  }

  @Post('complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cerrar el caso como completado (idempotente)' })
  @ApiOkResponse({ type: CaseResponseDto })
  @ApiConflictResponse({
    description: 'Reclamación inválida, caso cerrado o revisiones pendientes',
  })
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClaimReferenceDto,
  ) {
    return this.service.completeCase(id, dto);
  }

  @Post('fail')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cerrar el caso como fallido (idempotente)' })
  @ApiOkResponse({ type: CaseResponseDto })
  @ApiConflictResponse({ description: 'Reclamación inválida o caso cerrado' })
  fail(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FailCaseDto) {
    return this.service.failCase(id, dto);
  }
}

/** Barrido de vencimientos HITL, para un workflow programado. */
@ApiTags('internal: hitl requests')
@ServiceRoute()
@ApiUnauthorizedResponse({
  description: 'Token de servicio ausente o inválido',
})
@Controller('internal/hitl-requests')
export class InternalHitlController {
  constructor(private readonly service: HitlService) {}

  @Post('expire')
  @Suspendable('hitl_expiry')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Marcar como vencidas las revisiones pendientes cuya fecha límite pasó',
    description:
      'Nunca aprueba nada. Si el caso queda sin revisiones pendientes, se cierra como failed.',
  })
  @ApiOkResponse({ type: ExpireHitlResponseDto })
  async expire(@Body() dto: ExpireHitlDto): Promise<ExpireHitlResponseDto> {
    return {
      expired: await this.service.expireDue(
        { kind: 'workflow', workerId: dto.workerId },
        dto.limit ?? 50,
      ),
    };
  }
}
