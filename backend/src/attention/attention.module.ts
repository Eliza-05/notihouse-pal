import { Module } from '@nestjs/common';
import { DueDatesModule } from '../due-dates/due-dates.module.js';
import { AttentionController } from './attention.controller.js';
import { AttentionService } from './attention.service.js';

/** Bandeja unificada de atención (solo lectura). */
@Module({
  imports: [DueDatesModule],
  controllers: [AttentionController],
  providers: [AttentionService],
})
export class AttentionModule {}
