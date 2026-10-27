import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { RentChargesController } from './rent-charges.controller.js';
import { RentChargesService } from './rent-charges.service.js';
import { RentalsController } from './rentals.controller.js';
import { RentalsService } from './rentals.service.js';

/** Arriendos, sus cobros por período y la confirmación manual de recepción. */
@Module({
  imports: [AuditModule],
  controllers: [RentalsController, RentChargesController],
  providers: [RentalsService, RentChargesService],
})
export class RentalsModule {}
