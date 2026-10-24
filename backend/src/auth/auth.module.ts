import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  LOGIN_RATE_LIMIT,
} from './auth.constants.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

/**
 * Autenticación local (correo + contraseña Argon2id) con JWT de 30 minutos.
 * Registra `JwtAuthGuard` como guard global: las rutas son privadas por defecto.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const secret = config.get('JWT_SECRET', { infer: true });
        if (!secret) {
          throw new Error('JWT_SECRET no está configurada');
        }
        return {
          secret,
          signOptions: {
            algorithm: JWT_ALGORITHM,
            expiresIn: ACCESS_TOKEN_TTL_SECONDS,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
          },
          verifyOptions: {
            algorithms: [JWT_ALGORITHM],
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
          },
        };
      },
    }),
    // Almacenamiento en memoria: válido para una sola instancia (ver documentación).
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'login',
          limit: LOGIN_RATE_LIMIT.limit,
          ttl: LOGIN_RATE_LIMIT.ttlMs,
        },
      ],
      errorMessage:
        'Demasiados intentos de inicio de sesión. Intenta más tarde.',
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}
