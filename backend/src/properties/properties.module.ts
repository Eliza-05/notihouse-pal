import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PropertiesController } from './properties.controller.js';
import { PropertiesService } from './properties.service.js';

/** Inmuebles administrados por el usuario autenticado. */
@Module({
  imports: [AuditModule],
  controllers: [PropertiesController],
  providers: [PropertiesService],
})
export class PropertiesModule {}
