import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DueDatesModule } from '../due-dates/due-dates.module.js';
import { InternalRecurrenceController } from './internal-recurrence.controller.js';
import { RecurrenceService } from './recurrence.service.js';

/** Generación automática de períodos y cobros recurrentes (§19.4). */
@Module({
  imports: [AuditModule, DueDatesModule],
  controllers: [InternalRecurrenceController],
  providers: [RecurrenceService],
  exports: [RecurrenceService],
})
export class RecurrenceModule {}
