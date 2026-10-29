import { Module } from '@nestjs/common';
import { CLOCK, systemClock } from './clock.js';
import { DueDateEvaluationService } from './due-date-evaluation.service.js';

/** Motor determinístico de vencimientos (sin escrituras). */
@Module({
  providers: [
    { provide: CLOCK, useValue: systemClock },
    DueDateEvaluationService,
  ],
  exports: [CLOCK, DueDateEvaluationService],
})
export class DueDatesModule {}
