import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DueDatesModule } from '../due-dates/due-dates.module.js';
import { AlertEvaluationService } from './alert-evaluation.service.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';
import { InternalAlertsController } from './internal-alerts.controller.js';

/** Alertas internas: consulta del usuario y evaluación programable. */
@Module({
  imports: [AuditModule, DueDatesModule],
  controllers: [AlertsController, InternalAlertsController],
  providers: [AlertsService, AlertEvaluationService],
})
export class AlertsModule {}
