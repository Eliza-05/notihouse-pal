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
  ConfirmRentChargeDto,
  CreateRentChargeDto,
  ListRentChargesQueryDto,
  RentChargePageDto,
  RentChargeResponseDto,
  UpdateRentChargeDto,
} from './dto/rent-charge.dto.js';
import { RentChargesService } from './rent-charges.service.js';

/** Cobros de un arriendo propio. Sin DELETE ni generación o confirmación automática. */
@ApiTags('rent charges')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@ApiNotFoundResponse({
  description: 'Arriendo o cobro inexistente o de otro propietario',
})
@Controller('rentals/:id/charges')
export class RentChargesController {
  constructor(private readonly service: RentChargesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar cobros (ordenados por fecha esperada)' })
  @ApiOkResponse({ type: RentChargePageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) rentalId: string,
    @Query() query: ListRentChargesQueryDto,
  ) {
    return this.service.list(user, rentalId, query);
  }

  @Get(':chargeId')
  @ApiOperation({ summary: 'Consultar un cobro' })
  @ApiOkResponse({ type: RentChargeResponseDto })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) rentalId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
  ) {
    return this.service.findOne(user, rentalId, chargeId);
  }

  @Post()
  @ApiOperation({ summary: 'Crear un cobro esperado (siempre en expected)' })
  @ApiCreatedResponse({ type: RentChargeResponseDto })
  @ApiBadRequestResponse({
    description: 'Fechas o monto inválidos, o período fuera de la vigencia',
  })
  @ApiConflictResponse({ description: 'Cobro duplicado o arriendo terminado' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) rentalId: string,
    @Body() dto: CreateRentChargeDto,
  ) {
    return this.service.create(user, correlationId, rentalId, dto);
  }

  @Patch(':chargeId')
  @ApiOperation({
    summary: 'Editar un cobro abierto (o anularlo con status=cancelled)',
  })
  @ApiOkResponse({ type: RentChargeResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({
    description: 'Cobro recibido/anulado o cobro duplicado',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) rentalId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
    @Body() dto: UpdateRentChargeDto,
  ) {
    return this.service.update(user, correlationId, rentalId, chargeId, dto);
  }

  @Post(':chargeId/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirmación humana de recepción del cobro',
    description:
      'El propietario declara que recibió el cobro; NotiHouse-Pal no verifica transacciones bancarias. ' +
      'Repetir la confirmación con la misma evidencia devuelve el cobro sin cambios; ' +
      'otra evidencia o un cobro anulado devuelven 409.',
  })
  @ApiOkResponse({ type: RentChargeResponseDto })
  @ApiBadRequestResponse({ description: 'Evidencia ausente o inválida' })
  @ApiConflictResponse({
    description: 'Estado incompatible con la confirmación',
  })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Param('id', ParseUUIDPipe) rentalId: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
    @Body() dto: ConfirmRentChargeDto,
  ) {
    return this.service.confirm(user, correlationId, rentalId, chargeId, dto);
  }
}
