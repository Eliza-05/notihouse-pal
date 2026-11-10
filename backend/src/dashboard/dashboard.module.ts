import { Module } from '@nestjs/common';
import { DueDatesModule } from '../due-dates/due-dates.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/** Indicadores agregados para la pantalla principal (solo lectura). */
@Module({
  imports: [DueDatesModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
