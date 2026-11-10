import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { EnvironmentVariables } from '../config/env.validation.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Verifica el token Bearer del servicio de automatización (`N8N_SERVICE_TOKEN`).
 * Compara resúmenes SHA-256 de longitud fija con `timingSafeEqual`, de modo
 * que el tiempo de respuesta no revela ni el contenido ni la longitud del token.
 * Sin token configurado, toda solicitud de servicio se rechaza.
 */
@Injectable()
export class ServiceTokenVerifier {
  private readonly expected: Buffer | null;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const token = config.get('N8N_SERVICE_TOKEN', { infer: true });
    this.expected = token ? digest(token) : null;
    if (!token) {
      new Logger(ServiceTokenVerifier.name).warn(
        'N8N_SERVICE_TOKEN no está configurada: las rutas internas rechazarán toda solicitud',
      );
    }
  }

  matches(candidate: string): boolean {
    if (!this.expected) return false;
    return timingSafeEqual(digest(candidate), this.expected);
  }
}
