import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { WorkflowJobsController } from './workflow-jobs.controller.js';
import { WorkflowJobsService } from './workflow-jobs.service.js';

/** Cola de trabajos consumida por n8n mediante rutas internas autenticadas. */
@Module({
  imports: [AuditModule],
  controllers: [WorkflowJobsController],
  providers: [WorkflowJobsService],
  exports: [WorkflowJobsService],
})
export class IntegrationsModule {}
