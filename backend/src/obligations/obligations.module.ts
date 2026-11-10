import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ObligationsController } from './obligations.controller.js';
import { ObligationsService } from './obligations.service.js';
import { OccurrencesController } from './occurrences.controller.js';
import { OccurrencesService } from './occurrences.service.js';

/** Obligaciones recurrentes del hogar, sus períodos y la confirmación manual. */
@Module({
  imports: [AuditModule],
  controllers: [ObligationsController, OccurrencesController],
  providers: [ObligationsService, OccurrencesService],
  exports: [ObligationsService, OccurrencesService],
})
export class ObligationsModule {}
