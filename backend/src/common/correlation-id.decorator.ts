import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `correlation_id` de la solicitud: el de la cabecera `X-Correlation-Id` si es
 * un UUID válido; si no, uno nuevo. Se devuelve en la misma cabecera de la
 * respuesta para poder rastrear el evento de auditoría.
 */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const http = ctx.switchToHttp();
    const request = http.getRequest<Request & { correlationId?: string }>();
    if (!request.correlationId) {
      const header = request.headers[CORRELATION_HEADER];
      request.correlationId =
        typeof header === 'string' && UUID.test(header) ? header : randomUUID();
      http
        .getResponse<Response>()
        .setHeader(CORRELATION_HEADER, request.correlationId);
    }
    return request.correlationId;
  },
);
