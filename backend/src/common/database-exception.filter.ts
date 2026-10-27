import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/** Mensajes para restricciones conocidas; el resto usa un texto genérico. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  properties_owner_name_unique: 'Ya existe un inmueble con ese nombre',
  obligation_occurrences_period_unique:
    'Ya existe un período con esa fecha de inicio para esta obligación',
  rent_charges_period_unique:
    'Ya existe un cobro con esa fecha de inicio de período para este arriendo',
  workflow_jobs_idempotency_key_unique:
    'Ya existe un trabajo con esa clave de idempotencia',
  case_proposals_case_version_unique:
    'Otra propuesta se registró al mismo tiempo; reintenta',
};

/** Conflictos de concurrencia de PostgreSQL: el cliente puede reintentar. */
const CONCURRENCY_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
]);

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

interface DatabaseErrorInfo {
  code?: string;
  constraint?: string;
  message: string;
}

/** Busca el error de PostgreSQL dentro de los envoltorios de Drizzle. */
export function findDatabaseError(error: unknown): DatabaseErrorInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const candidate = current as Error & {
      code?: unknown;
      constraint?: unknown;
    };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint === 'string'
            ? candidate.constraint
            : undefined,
        message: candidate.message,
      };
    }
    if (
      /timeout exceeded when trying to connect|Connection terminated/i.test(
        candidate.message,
      )
    ) {
      return { code: 'ETIMEDOUT', message: candidate.message };
    }
    current = candidate.cause;
  }
  return null;
}

/** Traduce un error de base de datos a una respuesta HTTP sin detalles internos. */
export function toHttpException(error: unknown): HttpException | null {
  const db = findDatabaseError(error);
  if (!db?.code) return null;
  const { code, constraint } = db;

  if (code === '23505') {
    return new ConflictException(
      (constraint && CONSTRAINT_MESSAGES[constraint]) ??
        'Conflicto con datos existentes',
    );
  }
  if (CONCURRENCY_CODES.has(code)) {
    return new ConflictException(
      'La operación entró en conflicto con otra simultánea; reintenta',
    );
  }
  // not_null, check, foreign_key, valores fuera de rango o con formato inválido.
  if (
    ['23502', '23514', '23503', '22P02', '22007', '22008', '22003'].includes(
      code,
    )
  ) {
    return new BadRequestException(
      'Los datos no cumplen las reglas del sistema',
    );
  }
  if (CONNECTION_CODES.has(code) || code.startsWith('08')) {
    return new ServiceUnavailableException(
      'La base de datos no está disponible. Intenta más tarde.',
    );
  }
  return null;
}

/**
 * Filtro global: los errores conocidos de PostgreSQL se convierten en 400, 409
 * o 503; el resto mantiene el comportamiento estándar de Nest (500 genérico,
 * sin exponer SQL ni credenciales).
 */
@Catch()
export class DatabaseExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(DatabaseExceptionFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException)) {
      const mapped = toHttpException(exception);
      if (mapped) {
        const db = findDatabaseError(exception);
        this.logger.warn(
          `Error de base de datos ${db?.code ?? '?'}${db?.constraint ? ` (${db.constraint})` : ''} → ${mapped.getStatus()}`,
        );
        return super.catch(mapped, host);
      }
    }
    return super.catch(exception, host);
  }
}
