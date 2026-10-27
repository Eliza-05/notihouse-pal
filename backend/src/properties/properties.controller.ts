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
import {
  CreatePropertyDto,
  ListPropertiesQueryDto,
  PropertyPageDto,
  PropertyResponseDto,
  UpdatePropertyDto,
} from './dto/property.dto.js';
import { PropertiesService } from './properties.service.js';

/** Inmuebles del usuario autenticado. Sin DELETE: se desactivan por estado. */
@ApiTags('properties')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('properties')
export class PropertiesController {
  constructor(private readonly service: PropertiesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar inmuebles propios' })
  @ApiOkResponse({ type: PropertyPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPropertiesQueryDto,
  ) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar un inmueble propio' })
  @ApiOkResponse({ type: PropertyResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Post()
  @ApiOperation({ summary: 'Crear inmueble' })
  @ApiCreatedResponse({ type: PropertyResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({ description: 'Ya existe un inmueble con ese nombre' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Body() dto: CreatePropertyDto,
  ) {
    return this.service.create(user, correlationId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualizar inmueble propio (incluye desactivarlo por estado)',
  })
  @ApiOkResponse({ type: PropertyResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  @ApiConflictResponse({ description: 'Ya existe un inmueble con ese nombre' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePropertyDto,
  ) {
    return this.service.update(user, correlationId, id, dto);
  }
}
