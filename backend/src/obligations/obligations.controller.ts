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
  ArchiveObligationResponseDto,
  CreateObligationDto,
  ListObligationsQueryDto,
  ObligationPageDto,
  ObligationResponseDto,
  UpdateObligationDto,
} from './dto/obligation.dto.js';
import { ObligationsService } from './obligations.service.js';

/** Definiciones de obligaciones recurrentes del usuario autenticado. Sin DELETE. */
@ApiTags('obligations')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('obligations')
export class ObligationsController {
  constructor(private readonly service: ObligationsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar obligaciones propias' })
  @ApiOkResponse({ type: ObligationPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListObligationsQueryDto,
  ) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar una obligación propia' })
  @ApiOkResponse({ type: ObligationResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Crear obligación (opcionalmente asociada a un inmueble propio)',
  })
  @ApiCreatedResponse({ type: ObligationResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({
    description: 'El inmueble no existe o es de otro propietario',
  })
  @ApiConflictResponse({ description: 'El inmueble no está activo' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Body() dto: CreateObligationDto,
  ) {
    return this.service.create(user, correlationId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualizar la definición (no modifica períodos registrados)',
  })
  @ApiOkResponse({ type: ObligationResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({
    description: 'Obligación o inmueble inexistente o ajeno',
  })
  @ApiConflictResponse({
    description: 'Obligación archivada o inmueble no activo',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateObligationDto,
  ) {
    return this.service.update(user, correlationId, id, dto);
  }
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Archivar la obligación (no genera más períodos; conserva el historial y los períodos pendientes)',
  })
  @ApiOkResponse({ type: ArchiveObligationResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  @ApiConflictResponse({ description: 'La obligación ya estaba archivada' })
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.archive(user, correlationId, id);
  }
}
