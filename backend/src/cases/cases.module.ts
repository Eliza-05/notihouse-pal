import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { CaseProcessService } from './case-process.service.js';
import { CasesController } from './cases.controller.js';
import { CasesService } from './cases.service.js';
import { HitlController } from './hitl.controller.js';
import { HitlService } from './hitl.service.js';
import {
  InternalCasesController,
  InternalHitlController,
} from './internal-cases.controller.js';

/** Casos (correlation_id), propuestas de IA y revisiones humanas (HITL). */
@Module({
  imports: [AuditModule, IntegrationsModule],
  controllers: [
    CasesController,
    HitlController,
    InternalCasesController,
    InternalHitlController,
  ],
  providers: [CasesService, HitlService, CaseProcessService],
})
export class CasesModule {}
