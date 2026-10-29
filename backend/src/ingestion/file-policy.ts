import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { MP4_AUDIO_BRANDS } from './audio-structure.js';

export type UploadKind = 'pdf' | 'audio';
export type FileFormat = 'pdf' | 'webm' | 'wav' | 'mp3' | 'm4a' | 'ogg';

interface FormatRule {
  kind: UploadKind;
  extensions: readonly string[];
  /** Content-Type aceptados del cliente (sin parámetros). */
  clientMimes: readonly string[];
  /** MIME que se guarda y se sirve; nunca el del cliente. */
  mimeType: string;
}

/**
 * Formatos admitidos. Cada uno exige coincidencia entre extensión,
 * Content-Type declarado y firma real del contenido.
 */
export const FILE_FORMATS: Record<FileFormat, FormatRule> = {
  pdf: {
    kind: 'pdf',
    extensions: ['.pdf'],
    clientMimes: ['application/pdf'],
    mimeType: 'application/pdf',
  },
  webm: {
    kind: 'audio',
    extensions: ['.webm'],
    clientMimes: ['audio/webm'],
    mimeType: 'audio/webm',
  },
  wav: {
    kind: 'audio',
    extensions: ['.wav'],
    clientMimes: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
    mimeType: 'audio/wav',
  },
  mp3: {
    kind: 'audio',
    extensions: ['.mp3'],
    clientMimes: ['audio/mpeg', 'audio/mp3'],
    mimeType: 'audio/mpeg',
  },
  m4a: {
    kind: 'audio',
    extensions: ['.m4a'],
    clientMimes: ['audio/mp4', 'audio/x-m4a', 'audio/m4a'],
    mimeType: 'audio/mp4',
  },
  ogg: {
    kind: 'audio',
    extensions: ['.ogg'],
    clientMimes: ['audio/ogg'],
    mimeType: 'audio/ogg',
  },
};

/** Bytes iniciales y finales que conserva el receptor para validar firmas. */
export const HEAD_BYTES = 4096;
export const TAIL_BYTES = 1024;
export const MAX_FILE_NAME_LENGTH = 255;

const ascii = (buffer: Buffer, start: number, end: number) =>
  buffer.subarray(start, end).toString('latin1');

/**
 * Formato real según la firma del contenido (no según nombre ni MIME).
 * Comprobaciones mínimas de estructura; no garantizan un archivo sano.
 */
export function detectFormat(head: Buffer): FileFormat | null {
  if (/^%PDF-[12]\.\d/.test(ascii(head, 0, 8))) return 'pdf';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') {
    return 'wav';
  }
  if (ascii(head, 0, 4) === 'OggS') {
    // Solo audio Ogg (Opus o Vorbis) en la cabecera inicial.
    const start = ascii(head, 0, 256);
    return start.includes('OpusHead') || start.includes('\x01vorbis')
      ? 'ogg'
      : null;
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    // Encabezado EBML con DocType "webm" (Matroska genérico no se acepta).
    return ascii(head, 0, 64).includes('webm') ? 'webm' : null;
  }
  if (ascii(head, 4, 8) === 'ftyp') {
    // Marcas ISO BMFF que pueden contener audio (M4A, isom, mp42…). La marca
    // no basta: verifyAudioStructure exige que todas las pistas sean de audio.
    const boxSize = head.readUInt32BE(0);
    const brands: string[] = [];
    for (let i = 8; i + 4 <= Math.min(boxSize, 64, head.length); i += 4) {
      if (i !== 12) brands.push(ascii(head, i, i + 4)); // 12-16: versión menor
    }
    return brands.some((b) => MP4_AUDIO_BRANDS.has(b)) ? 'm4a' : null;
  }
  if (ascii(head, 0, 3) === 'ID3') return 'mp3';
  // Sincronía de trama MPEG-1/2 capa III sin etiqueta ID3.
  if (
    head[0] === 0xff &&
    (head[1]! & 0xe0) === 0xe0 &&
    (head[1]! & 0x06) === 0x02
  ) {
    return 'mp3';
  }
  return null;
}

/**
 * Nombre original apto para metadatos: sin rutas, caracteres de control ni
 * separadores. Nunca se usa para construir rutas ni comandos.
 */
export function sanitizeFileName(name: string): string | null {
  const base = name.normalize('NFC').split(/[\\/]/).pop() ?? '';
  const clean = base
    // Quitar caracteres de control del nombre es el objetivo de esta expresión.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return clean === '' ? null : clean.slice(0, 200);
}

/** Construcciones PDF con contenido activo; se rechazan (detección heurística). */
const PDF_ACTIVE_CONTENT =
  /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA)(?![A-Za-z0-9])/;
const SCAN_OVERLAP = 32;

/**
 * Busca construcciones activas en un PDF por fragmentos, sin cargar el
 * archivo entero. Es una defensa heurística: los objetos comprimidos o los
 * nombres ofuscados pueden ocultarlas, así que NO equivale a sanitizar.
 */
export class PdfActiveContentScanner {
  private carry = '';
  found = false;

  push(chunk: Buffer): void {
    if (this.found) return;
    const text = this.carry + chunk.toString('latin1');
    if (PDF_ACTIVE_CONTENT.test(text)) this.found = true;
    this.carry = text.slice(-SCAN_OVERLAP);
  }
}

export interface ReceivedFile {
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
  sha256: string;
  head: Buffer;
  tail: Buffer;
  pdfActiveContent: boolean;
}

export interface AcceptedFile {
  format: FileFormat;
  mimeType: string;
  fileName: string | null;
}

/**
 * Política de aceptación: archivo no vacío, nombre acotado, extensión,
 * Content-Type declarado y firma coherentes, y estructura mínima. El tamaño
 * máximo ya lo aplicó el receptor multipart (413).
 */
export function acceptUpload(
  kind: UploadKind,
  file: ReceivedFile,
): AcceptedFile {
  if (file.size === 0) throw new BadRequestException('El archivo está vacío');
  if (Buffer.byteLength(file.originalname, 'utf8') > MAX_FILE_NAME_LENGTH) {
    throw new BadRequestException(
      `El nombre del archivo supera ${MAX_FILE_NAME_LENGTH} bytes`,
    );
  }
  const extension = /\.[A-Za-z0-9]+$/
    .exec(file.originalname)?.[0]
    ?.toLowerCase();
  const declared = file.mimetype.split(';')[0]!.trim().toLowerCase();
  const detected = detectFormat(file.head);
  const rule = detected ? FILE_FORMATS[detected] : null;

  if (
    !rule ||
    rule.kind !== kind ||
    !extension ||
    !rule.extensions.includes(extension) ||
    !rule.clientMimes.includes(declared)
  ) {
    throw new UnsupportedMediaTypeException(
      kind === 'pdf'
        ? 'Solo se admiten facturas PDF: extensión .pdf, tipo application/pdf y contenido PDF'
        : 'Formato de audio no admitido o el contenido no coincide con la extensión y el tipo declarados',
    );
  }
  if (detected === 'pdf') {
    if (!file.tail.toString('latin1').includes('%%EOF')) {
      throw new BadRequestException('El PDF está incompleto o mal formado');
    }
    if (file.pdfActiveContent) {
      throw new UnsupportedMediaTypeException(
        'El PDF contiene contenido activo (JavaScript, acciones o archivos incrustados) y no se admite',
      );
    }
  }
  return {
    format: detected!,
    mimeType: rule.mimeType,
    fileName: sanitizeFileName(file.originalname),
  };
}
