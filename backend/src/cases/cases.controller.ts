import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
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
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CORRELATION_HEADER } from '../common/correlation-id.decorator.js';
import { CasesService } from './cases.service.js';
import {
  CasePageDto,
  CaseResponseDto,
  CreateCaseDto,
  ListCasesQueryDto,
} from './dto/case.dto.js';
import { ListProposalsQueryDto, ProposalPageDto } from './dto/process.dto.js';
import {
  ApplyProposalDto,
  ProposalApplicationResponseDto,
} from './dto/proposal-application.dto.js';
import { ProposalApplicationService } from './proposal-application.service.js';
import { Suspendable } from '../kill-switch/kill-switch.guard.js';

/** Casos del usuario autenticado. Sin DELETE ni cambios de estado manuales. */
@ApiTags('cases')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('cases')
export class CasesController {
  constructor(
    private readonly service: CasesService,
    private readonly applications: ProposalApplicationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar casos propios (más recientes primero)' })
  @ApiOkResponse({ type: CasePageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListCasesQueryDto,
  ) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar un caso propio' })
  @ApiOkResponse({ type: CaseResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Crear un caso y su trabajo inicial de automatización',
    description:
      'Estado inicial `received`, origen `form`. Con `requestId`, repetir la solicitud devuelve el caso existente con 200.',
  })
  @ApiCreatedResponse({ type: CaseResponseDto })
  @ApiOkResponse({
    type: CaseResponseDto,
    description: 'Repetición idempotente',
  })
  @ApiBadRequestResponse({ description: 'Tipo o referencia inválidos' })
  @ApiNotFoundResponse({ description: 'Entidad referida inexistente o ajena' })
  @ApiConflictResponse({ description: 'requestId reutilizado con otros datos' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCaseDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CaseResponseDto> {
    const { created, case: row } = await this.service.create(user, dto);
    res.status(created ? 201 : 200);
    // El correlation_id del caso identifica todo el proceso.
    res.setHeader(CORRELATION_HEADER, row.correlationId);
    return row;
  }

  @Get(':id/proposals')
  @ApiOperation({
    summary:
      'Propuestas del caso (por versión). Ninguna es información definitiva.',
  })
  @ApiOkResponse({ type: ProposalPageDto })
  @ApiNotFoundResponse({
    description: 'Caso inexistente o de otro propietario',
  })
  listProposals(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListProposalsQueryDto,
  ) {
    return this.service.listProposals(user, id, query);
  }

  @Post(':caseId/proposals/:proposalId/apply')
  @Suspendable('proposal_application')
  @ApiOperation({
    summary: 'Aplicar una propuesta aprobada (acciones permitidas)',
    description:
      'Ejecuta solo acciones de la lista permitida (`create_obligation_occurrence`, `create_obligation_with_occurrence`) ' +
      'con los datos aprobados en la revisión humana; el cuerpo debe ir vacío. El período se crea `pending`: ' +
      'aplicar nunca registra pagos, cobros recibidos ni renovaciones. Repetir la solicitud devuelve 200 con la aplicación existente.',
  })
  @ApiCreatedResponse({ type: ProposalApplicationResponseDto })
  @ApiOkResponse({
    type: ProposalApplicationResponseDto,
    description: 'Ya aplicada (idempotente)',
  })
  @ApiBadRequestResponse({
    description: 'Acción no permitida o datos propuestos inválidos',
  })
  @ApiNotFoundResponse({
    description: 'Caso, propuesta u obligación inexistentes o ajenos',
  })
  @ApiConflictResponse({
    description:
      'Propuesta no aprobada, reemplazada o rechazada; aprobación inválida o fuera de plazo; período duplicado',
  })
  async applyProposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() _body: ApplyProposalDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProposalApplicationResponseDto> {
    const result = await this.applications.apply(user, caseId, proposalId);
    res.status(result.alreadyApplied ? 200 : 201);
    res.setHeader(CORRELATION_HEADER, result.correlationId);
    return result;
  }
}
