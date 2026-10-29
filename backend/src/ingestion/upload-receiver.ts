import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  mixin,
  type NestInterceptor,
  PayloadTooLargeException,
  ServiceUnavailableException,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import multer, { MulterError, type StorageEngine } from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { catchError, concatMap, finalize, type Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/authenticated-user.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  HEAD_BYTES,
  PdfActiveContentScanner,
  type ReceivedFile,
  TAIL_BYTES,
  type UploadKind,
} from './file-policy.js';

export const UPLOAD_FIELD = 'file';

/** Límites multipart además del tamaño del archivo. */
export const MULTIPART_LIMITS = {
  files: 1,
  fields: 8,
  fieldNameSize: 50,
  fieldSize: 256,
  parts: 9,
  headerPairs: 20,
} as const;

/** Subidas simultáneas admitidas, por usuario y en total (proceso). */
export const MAX_CONCURRENT_UPLOADS_PER_USER = 2;
export const MAX_CONCURRENT_UPLOADS = 10;

/**
 * Motor de Multer que escribe el archivo en un temporal privado mientras
 * calcula SHA-256, tamaño, bytes iniciales/finales y (para PDF) busca
 * contenido activo. Nada se carga entero en memoria; Multer corta el flujo
 * al superar `fileSize` y entonces el temporal se elimina.
 */
class TempFileEngine implements StorageEngine {
  constructor(
    private readonly dir: string,
    private readonly kind: UploadKind,
  ) {}

  _handleFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<ReceivedFile>) => void,
  ): void {
    const path = join(this.dir, `${randomUUID()}.upload`);
    const hash = createHash('sha256');
    const scanner = this.kind === 'pdf' ? new PdfActiveContentScanner() : null;
    let size = 0;
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    const inspect = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        hash.update(chunk);
        scanner?.push(chunk);
        if (head.length < HEAD_BYTES) {
          head = Buffer.concat([
            head,
            chunk.subarray(0, HEAD_BYTES - head.length),
          ]);
        }
        tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
        done(null, chunk);
      },
    });
    mkdir(this.dir, { recursive: true, mode: 0o700 })
      .then(() =>
        pipeline(
          file.stream,
          inspect,
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        ),
      )
      .then(() =>
        callback(null, {
          path,
          size,
          sha256: hash.digest('hex'),
          head,
          tail,
          pdfActiveContent: scanner?.found ?? false,
        }),
      )
      .catch(async (error: unknown) => {
        await unlink(path).catch(() => undefined);
        callback(error);
      });
  }

  _removeFile(
    _req: Request,
    file: Express.Multer.File & Partial<ReceivedFile>,
    callback: (error: Error | null) => void,
  ): void {
    if (!file.path) return callback(null);
    unlink(file.path).then(
      () => callback(null),
      () => callback(null),
    );
  }
}

/** Contador de subidas en curso. Proceso único (ver documentación). */
@Injectable()
export class UploadSlots {
  private total = 0;
  private readonly perUser = new Map<string, number>();

  acquire(userId: string): () => void {
    const current = this.perUser.get(userId) ?? 0;
    if (
      current >= MAX_CONCURRENT_UPLOADS_PER_USER ||
      this.total >= MAX_CONCURRENT_UPLOADS
    ) {
      throw new HttpException(
        'Demasiadas subidas simultáneas; espera a que terminen las anteriores',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.perUser.set(userId, current + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.perUser.get(userId) ?? 1) - 1;
      if (left <= 0) this.perUser.delete(userId);
      else this.perUser.set(userId, left);
    };
  }
}

function toHttpError(error: unknown, maxBytes: number): HttpException {
  if (error instanceof MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new PayloadTooLargeException(
        `El archivo supera el máximo permitido (${maxBytes} bytes)`,
      );
    }
    return new BadRequestException(
      error.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Envía un único archivo en el campo "${UPLOAD_FIELD}"`
        : 'Solicitud multipart fuera de los límites permitidos',
    );
  }
  const message = (error as Error | undefined)?.message ?? '';
  if (/multipart|boundary|unexpected end of form|malformed/i.test(message)) {
    return new BadRequestException('Solicitud multipart mal formada');
  }
  return new ServiceUnavailableException(
    'No fue posible recibir el archivo. Intenta más tarde.',
  );
}

/**
 * Interceptor de recepción: se ejecuta después del guard JWT (un usuario no
 * autenticado nunca llega a escribir en disco), aplica los límites de tamaño
 * en el propio flujo HTTP y garantiza que el temporal se elimine al terminar
 * la solicitud, con éxito o con error.
 */
export function ReceiveUpload(kind: UploadKind): Type<NestInterceptor> {
  @Injectable()
  class ReceiveUploadInterceptor implements NestInterceptor {
    private readonly logger = new Logger('UploadReceiver');

    constructor(
      @Inject(ConfigService)
      private readonly config: ConfigService<EnvironmentVariables, true>,
      @Inject(UploadSlots) private readonly slots: UploadSlots,
    ) {}

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      const http = context.switchToHttp();
      const req = http.getRequest<AuthenticatedRequest>();
      const res = http.getResponse<Response>();
      const release = this.slots.acquire(req.user!.profileId);
      const maxBytes = this.config.get(
        kind === 'pdf' ? 'STORAGE_MAX_PDF_BYTES' : 'STORAGE_MAX_AUDIO_BYTES',
        { infer: true },
      );
      const upload = multer({
        storage: new TempFileEngine(
          this.config.get('STORAGE_UPLOAD_TMP_PATH', { infer: true }),
          kind,
        ),
        limits: { ...MULTIPART_LIMITS, fileSize: maxBytes },
      }).single(UPLOAD_FIELD);

      // Idempotente. Se espera antes de responder: cuando el cliente recibe
      // la respuesta, el temporal ya no existe (aunque el disco esté lento).
      let cleaned: Promise<void> | null = null;
      const cleanup = () => {
        cleaned ??= (async () => {
          release();
          const path = (req.file as Partial<ReceivedFile> | undefined)?.path;
          if (path) {
            await unlink(path).catch(() =>
              this.logger.warn('No se pudo eliminar un temporal de subida'),
            );
          }
        })();
        return cleaned;
      };
      try {
        await new Promise<void>((resolve, reject) =>
          upload(req, res, (error: unknown) =>
            error ? reject(toHttpError(error, maxBytes)) : resolve(),
          ),
        );
      } catch (error) {
        await cleanup();
        throw error;
      }
      return next.handle().pipe(
        concatMap(async (value: unknown) => {
          await cleanup();
          return value;
        }),
        catchError(async (error: unknown) => {
          await cleanup();
          throw error;
        }),
        // Respaldo si la solicitud se cancela sin emitir ni fallar.
        finalize(() => void cleanup()),
      );
    }
  }
  return mixin(ReceiveUploadInterceptor);
}
