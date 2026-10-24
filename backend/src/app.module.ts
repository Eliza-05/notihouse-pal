import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ObligationsModule } from './obligations/obligations.module.js';
import { PropertiesModule } from './properties/properties.module.js';
import { RentalsModule } from './rentals/rentals.module.js';
import { ContractsModule } from './contracts/contracts.module.js';
import { CasesModule } from './cases/cases.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { AuditModule } from './audit/audit.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    HealthModule,
    AuthModule,
    ObligationsModule,
    PropertiesModule,
    RentalsModule,
    ContractsModule,
    CasesModule,
    IntegrationsModule,
    AuditModule,
  ],
})
export class AppModule {}
