import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AttentionService } from './attention.service.js';
import { AttentionPageDto, AttentionQueryDto } from './dto/attention.dto.js';

@ApiTags('attention')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('attention')
export class AttentionController {
  constructor(private readonly service: AttentionService) {}

  @Get()
  @ApiOperation({
    summary: 'Bandeja unificada: lo que requiere atención del usuario',
    description:
      'Períodos y cobros abiertos dentro del umbral o vencidos, contratos próximos a finalizar y revisiones HITL pendientes. ' +
      'Orden determinístico por prioridad (1 = más urgente), fecha, tipo e id; paginación sobre el conjunto unificado. Solo lectura.',
  })
  @ApiOkResponse({ type: AttentionPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AttentionQueryDto,
  ) {
    return this.service.list(user, query);
  }
}
