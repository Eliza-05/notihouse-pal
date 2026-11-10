import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CasesModule } from '../cases/cases.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { DocumentsService } from './documents.service.js';
import { ConfiguredMailboxes } from './gmail/configured-mailboxes.js';
import { GmailIngestionController } from './gmail/gmail-ingestion.controller.js';
import { GMAIL_MAILBOX_RESOLVER } from './gmail/gmail.contract.js';
import {
  DocumentsController,
  IngestionController,
  InternalDocumentsController,
} from './ingestion.controller.js';
import { IngestionService } from './ingestion.service.js';
import { UploadSlots } from './upload-receiver.js';

/**
 * Ingesta de documentos PDF y notas de voz, documentos privados, acceso del
 * worker a archivos y recepción de adjuntos de buzones de Gmail vinculados.
 * Reutiliza los casos y la cola de trabajos existentes.
 */
@Module({
  imports: [AuditModule, CasesModule, IntegrationsModule],
  controllers: [
    IngestionController,
    DocumentsController,
    InternalDocumentsController,
    GmailIngestionController,
  ],
  providers: [
    IngestionService,
    DocumentsService,
    UploadSlots,
    { provide: GMAIL_MAILBOX_RESOLVER, useClass: ConfiguredMailboxes },
  ],
})
export class IngestionModule {}
