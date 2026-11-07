import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import { ServiceRoute } from '../auth/service-route.decorator.js';
import { WORKER_ID_PATTERN } from '../integrations/job-claims.js';
import {
  KILL_SWITCH_SCOPES,
  type KillSwitchScope,
} from './kill-switch.scopes.js';
import {
  type KillSwitchEntry,
  KillSwitchService,
} from './kill-switch.service.js';

export class ActivateKillSwitchDto {
  @ApiProperty({ enum: KILL_SWITCH_SCOPES })
  @IsIn(KILL_SWITCH_SCOPES)
  scope: KillSwitchScope;

  @ApiProperty({ example: 'Respuestas de Gemini con instrucciones de pago' })
  @IsString()
  @Length(3, 500)
  reason: string;

  @ApiProperty({ example: 'n8n-local-1' })
  @Matches(WORKER_ID_PATTERN)
  workerId: string;
}

export class KillSwitchEntryDto {
  @ApiProperty({ enum: KILL_SWITCH_SCOPES }) scope: KillSwitchScope;
  @ApiProperty() label: string;
  @ApiProperty() active: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) changedAt: Date;
  @ApiPropertyOptional({
    enum: ['manual', 'consecutive_critical_failures', 'prohibited_operation'],
    nullable: true,
  })
  trigger: KillSwitchEntry['trigger'];
  @ApiProperty() reason: string;
  @ApiProperty() actor: string;
  @ApiProperty({ nullable: true }) correlationId: string | null;
}

export class KillSwitchStateDto {
  @ApiProperty({ type: [String], enum: KILL_SWITCH_SCOPES })
  activeScopes: KillSwitchScope[];
  @ApiProperty({ type: [KillSwitchEntryDto] }) scopes: KillSwitchEntryDto[];
}

export class LimitedFunctionDto {
  @ApiProperty({ enum: KILL_SWITCH_SCOPES }) scope: KillSwitchScope;
  @ApiProperty({ example: 'Interpretación automática de documentos PDF' })
  label: string;
  @ApiProperty({ type: String, format: 'date-time' }) since: Date;
}

export class SystemStatusDto {
  @ApiProperty({
    description:
      'true si alguna automatización está detenida por el kill switch',
  })
  limited: boolean;
  @ApiProperty({ type: [LimitedFunctionDto] })
  limitedFunctions: LimitedFunctionDto[];
  @ApiProperty({ type: String, format: 'date-time' }) serverTime: Date;
}

/**
 * Activación por el workflow (SDD: "el workflow puede activarlo
 * automáticamente"). No existe ninguna ruta de reanudación: reanudar exige
 * al responsable operativo y una prueba controlada (script de operación).
 */
@ApiTags('internal: kill switch')
@ServiceRoute()
@ApiUnauthorizedResponse({
  description: 'Token de servicio ausente o inválido',
})
@Controller('internal/kill-switch')
export class InternalKillSwitchController {
  constructor(private readonly killSwitch: KillSwitchService) {}

  @Get()
  @ApiOperation({ summary: 'Estado del kill switch por alcance' })
  @ApiOkResponse({ type: KillSwitchStateDto })
  async state(): Promise<KillSwitchStateDto> {
    const scopes = await this.killSwitch.state();
    return {
      activeScopes: scopes.filter((s) => s.active).map((s) => s.scope),
      scopes,
    };
  }

  @Post('activate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Activar el kill switch de un alcance (idempotente)',
    description:
      'Suspende las escrituras automáticas del componente. No borra datos ni bloquea lecturas. No hay ruta para reanudar.',
  })
  @ApiOkResponse({ type: KillSwitchEntryDto })
  async activate(
    @Body() dto: ActivateKillSwitchDto,
  ): Promise<KillSwitchEntryDto> {
    const { entry } = await this.killSwitch.activate({
      scope: dto.scope,
      reason: dto.reason,
      trigger: 'manual',
      actor: `n8n:${dto.workerId}`,
      actorType: 'workflow',
    });
    return entry;
  }
}

/** Lo que el frontend necesita para avisar de que una función está limitada. */
@ApiTags('system')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, inválido o expirado' })
@Controller('system')
export class SystemStatusController {
  constructor(private readonly killSwitch: KillSwitchService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Funciones temporalmente limitadas',
    description:
      'Sin motivos internos ni actores: solo qué función está limitada y desde cuándo.',
  })
  @ApiOkResponse({ type: SystemStatusDto })
  async status(): Promise<SystemStatusDto> {
    const active = (await this.killSwitch.state()).filter((s) => s.active);
    return {
      limited: active.length > 0,
      limitedFunctions: active.map((s) => ({
        scope: s.scope,
        label: s.label,
        since: s.changedAt,
      })),
      serverTime: new Date(),
    };
  }
}
