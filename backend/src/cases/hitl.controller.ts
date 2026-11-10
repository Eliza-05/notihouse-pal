import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import {
  DecideHitlDto,
  HitlDetailDto,
  HitlPageDto,
  ListHitlQueryDto,
} from './dto/process.dto.js';
import { HitlService } from './hitl.service.js';

/** Revisiones humanas asignadas al usuario autenticado. */
@ApiTags('hitl requests')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@ApiNotFoundResponse({ description: 'Inexistente o asignada a otro usuario' })
@Controller('hitl-requests')
export class HitlController {
  constructor(private readonly service: HitlService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar revisiones propias (más recientes primero)',
  })
  @ApiOkResponse({ type: HitlPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListHitlQueryDto,
  ) {
    return this.service.list(user, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Consultar una revisión con su propuesta vinculada',
  })
  @ApiOkResponse({ type: HitlDetailDto })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Aprobar o rechazar explícitamente',
    description:
      'Registra la decisión humana con actor y hora del servidor. Aprobar NO aplica datos a obligaciones, cobros ni contratos. ' +
      'Repetir la misma decisión devuelve la solicitud sin cambios; una decisión distinta o una solicitud vencida devuelven 409.',
  })
  @ApiOkResponse({ type: HitlDetailDto })
  @ApiBadRequestResponse({ description: 'Decisión o alternativa inválida' })
  @ApiConflictResponse({
    description:
      'Vencida, ya decidida de otra forma, anulada o propuesta reemplazada',
  })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideHitlDto,
  ) {
    return this.service.decide(user, id, dto);
  }
}
