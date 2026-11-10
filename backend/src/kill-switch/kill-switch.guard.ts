import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiServiceUnavailableResponse } from '@nestjs/swagger';
import type { KillSwitchScope } from './kill-switch.scopes.js';
import { KillSwitchService } from './kill-switch.service.js';

const SCOPE_KEY = 'killSwitchScope';

/**
 * Corta la ruta con 503 mientras su alcance (o el global) esté activo. Los
 * guards se ejecutan antes que los interceptores: una carga de Gmail se
 * rechaza sin recibir ni guardar el archivo.
 */
@Injectable()
export class KillSwitchGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly killSwitch: KillSwitchService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<KillSwitchScope | undefined>(
      SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (scope) await this.killSwitch.assertActive(scope);
    return true;
  }
}

/** Marca una ruta como escritura automática detenible por el kill switch. */
export const Suspendable = (scope: KillSwitchScope) =>
  applyDecorators(
    SetMetadata(SCOPE_KEY, scope),
    UseGuards(KillSwitchGuard),
    ApiServiceUnavailableResponse({
      description: `Kill switch activo (${scope}): función temporalmente limitada (code KILL_SWITCH_ACTIVE)`,
    }),
  );
