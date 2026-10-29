import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardSummaryDto } from './dto/dashboard.dto.js';

@ApiTags('dashboard')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Indicadores agregados del usuario autenticado',
    description:
      'Conteos y montos por moneda. Distingue valores esperados de confirmaciones declaradas por el usuario; ' +
      'ningún monto es un saldo bancario. Solo lectura.',
  })
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.service.summary(user);
  }
}
