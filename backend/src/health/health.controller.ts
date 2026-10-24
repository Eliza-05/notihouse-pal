import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator.js';
import { HealthResponseDto } from './health-response.dto.js';

export const SERVICE_NAME = 'notihouse-pal-api';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  /**
   * Liveness: indica únicamente que el proceso de la API responde.
   * No verifica dependencias externas (base de datos, n8n, Gmail).
   */
  @Get()
  @ApiOperation({ summary: 'Estado de la API (liveness)' })
  @ApiOkResponse({ type: HealthResponseDto })
  check(): HealthResponseDto {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      timestamp: new Date().toISOString(),
    };
  }
}
