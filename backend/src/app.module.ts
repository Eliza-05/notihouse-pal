import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ObligationsModule } from './obligations/obligations.module.js';
import { PropertiesModule } from './properties/properties.module.js';
import { RentalsModule } from './rentals/rentals.module.js';
import { ContractsModule } from './contracts/contracts.module.js';
import { CasesModule } from './cases/cases.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { AuditModule } from './audit/audit.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { StorageModule } from './storage/storage.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { AttentionModule } from './attention/attention.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { KillSwitchModule } from './kill-switch/kill-switch.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    DatabaseModule,
    KillSwitchModule,
    StorageModule,
    HealthModule,
    AuthModule,
    ObligationsModule,
    PropertiesModule,
    RentalsModule,
    ContractsModule,
    CasesModule,
    IntegrationsModule,
    IngestionModule,
    AlertsModule,
    AttentionModule,
    DashboardModule,
    AuditModule,
  ],
})
export class AppModule {}
