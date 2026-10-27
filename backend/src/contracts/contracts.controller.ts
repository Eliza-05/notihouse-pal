import {
  Body,
  Controller,
  Get,
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
import { ContractsService } from './contracts.service.js';
import {
  ContractPageDto,
  ContractResponseDto,
  CreateContractDto,
  ListContractsQueryDto,
  UpdateContractDto,
} from './dto/contract.dto.js';

/** Metadatos de contratos del usuario autenticado. Sin DELETE ni renovación automática. */
@ApiTags('contracts')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('contracts')
export class ContractsController {
  constructor(private readonly service: ContractsService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar contratos propios (por fecha de vencimiento)',
  })
  @ApiOkResponse({ type: ContractPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListContractsQueryDto,
  ) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar un contrato propio' })
  @ApiOkResponse({ type: ContractResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Registrar metadatos de un contrato (siempre en active)',
  })
  @ApiCreatedResponse({ type: ContractResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, endsOn ausente, fechas contradictorias o arriendo de otro inmueble',
  })
  @ApiNotFoundResponse({
    description: 'Inmueble, arriendo o documento inexistente o ajeno',
  })
  @ApiConflictResponse({ description: 'El inmueble no está activo' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Body() dto: CreateContractDto,
  ) {
    return this.service.create(user, correlationId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Corregir metadatos de un contrato activo (sin renovarlo)',
  })
  @ApiOkResponse({ type: ContractResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({
    description: 'Contrato o documento inexistente o ajeno',
  })
  @ApiConflictResponse({ description: 'Contrato vencido o terminado' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContractDto,
  ) {
    return this.service.update(user, correlationId, id, dto);
  }
}
