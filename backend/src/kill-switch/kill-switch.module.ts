import { Global, Module } from '@nestjs/common';
import {
  InternalKillSwitchController,
  SystemStatusController,
} from './kill-switch.controllers.js';
import { KillSwitchGuard } from './kill-switch.guard.js';
import { KillSwitchService } from './kill-switch.service.js';

/** Global: cualquier módulo con escrituras automáticas puede consultarlo. */
@Global()
@Module({
  controllers: [InternalKillSwitchController, SystemStatusController],
  providers: [KillSwitchService, KillSwitchGuard],
  exports: [KillSwitchService, KillSwitchGuard],
})
export class KillSwitchModule {}
