import { StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { DocumentContent } from './documents.service.js';

const EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
};

/**
 * Respuesta de descarga privada: siempre como adjunto, con el MIME validado
 * al recibir el archivo, sin caché compartida y con `nosniff` y una CSP que
 * impide ejecutar cualquier contenido si el navegador lo abriera.
 */
export function privateDownload(
  res: Response,
  { document, object }: DocumentContent,
): StreamableFile {
  const fallbackName = `documento-${document.id}.${EXTENSION[document.mimeType] ?? 'bin'}`;
  const name = document.fileName ?? fallbackName;
  const ascii = name.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; sandbox; frame-ancestors 'none'",
  );
  return new StreamableFile(object.stream, {
    type: document.mimeType,
    length: object.size,
    disposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
}
