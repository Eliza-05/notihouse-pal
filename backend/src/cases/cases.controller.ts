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

/** Casos del usuario autenticado. Sin DELETE ni cambios de estado manuales. */
@ApiTags('cases')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('cases')
export class CasesController {
  constructor(private readonly service: CasesService) {}

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
}
