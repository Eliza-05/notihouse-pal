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
  CreateRentalDto,
  ListRentalsQueryDto,
  RentalPageDto,
  RentalResponseDto,
  UpdateRentalDto,
} from './dto/rental.dto.js';
import { RentalsService } from './rentals.service.js';

/** Arriendos de inmuebles del usuario autenticado. Sin DELETE. */
@ApiTags('rentals')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('rentals')
export class RentalsController {
  constructor(private readonly service: RentalsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar arriendos propios' })
  @ApiOkResponse({ type: RentalPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListRentalsQueryDto,
  ) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar un arriendo propio' })
  @ApiOkResponse({ type: RentalResponseDto })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Post()
  @ApiOperation({ summary: 'Registrar un arriendo sobre un inmueble propio' })
  @ApiCreatedResponse({ type: RentalResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({
    description: 'El inmueble no existe o es de otro propietario',
  })
  @ApiConflictResponse({ description: 'El inmueble no está activo' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Body() dto: CreateRentalDto,
  ) {
    return this.service.create(user, correlationId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualizar el arriendo (no modifica cobros ni contratos)',
  })
  @ApiOkResponse({ type: RentalResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({ description: 'Inexistente o de otro propietario' })
  @ApiConflictResponse({ description: 'Arriendo terminado' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRentalDto,
  ) {
    return this.service.update(user, correlationId, id, dto);
  }
}
