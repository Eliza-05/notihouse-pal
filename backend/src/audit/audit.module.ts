import { Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Trazabilidad de acciones: registro transaccional en `audit_events`. */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
