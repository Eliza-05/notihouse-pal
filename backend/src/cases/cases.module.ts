import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DueDatesModule } from '../due-dates/due-dates.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { ObligationsModule } from '../obligations/obligations.module.js';
import { RecurrenceModule } from '../recurrence/recurrence.module.js';
import { RentalsModule } from '../rentals/rentals.module.js';
import { CaseProcessService } from './case-process.service.js';
import { CasesController } from './cases.controller.js';
import { CasesService } from './cases.service.js';
import { HitlController } from './hitl.controller.js';
import { HitlService } from './hitl.service.js';
import { ProposalApplicationService } from './proposal-application.service.js';
import {
  InternalCasesController,
  InternalHitlController,
} from './internal-cases.controller.js';

/** Casos (correlation_id), propuestas de IA y revisiones humanas (HITL). */
@Module({
  imports: [
    AuditModule,
    IntegrationsModule,
    ObligationsModule,
    RentalsModule,
    RecurrenceModule,
    DueDatesModule,
  ],
  controllers: [
    CasesController,
    HitlController,
    InternalCasesController,
    InternalHitlController,
  ],
  providers: [
    CasesService,
    HitlService,
    CaseProcessService,
    ProposalApplicationService,
  ],
  exports: [CasesService],
})
export class CasesModule {}
