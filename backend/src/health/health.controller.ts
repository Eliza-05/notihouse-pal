import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/public.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import {
  HealthResponseDto,
  ReadinessResponseDto,
} from './health-response.dto.js';

/** Tiempo máximo de la comprobación de PostgreSQL en readiness. */
export const READINESS_TIMEOUT_MS = 3000;

export const SERVICE_NAME = 'notihouse-pal-api';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly database: DatabaseService) {}

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

  /**
   * Readiness: comprueba PostgreSQL con `SELECT 1` y un tiempo máximo. Solo
   * informa "ok"/"unavailable": nunca el host, el error ni credenciales. No
   * debe usarse como health check de reinicio (un arranque en frío de Neon
   * reiniciaría la instancia sin motivo); para eso está `GET /health`.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Disponibilidad de PostgreSQL (readiness)' })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiServiceUnavailableResponse({ description: 'PostgreSQL no disponible' })
  async ready(): Promise<ReadinessResponseDto> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS);
    });
    const ok = await Promise.race([
      this.database.ping().catch(() => false),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const body: ReadinessResponseDto = {
      status: ok ? 'ready' : 'unavailable',
      service: SERVICE_NAME,
      checks: { database: ok ? 'ok' : 'unavailable' },
      timestamp: new Date().toISOString(),
    };
    if (!ok) {
      this.logger.warn('Readiness: PostgreSQL no disponible');
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
