import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Archivos sintéticos mínimos para pruebas: sin datos personales ni
 * contenido real. Solo reproducen las firmas y estructuras que valida la API.
 */

export const samplePdf = (body = 'Factura ficticia de prueba') =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
      `2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n` +
      `% ${body}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  );

export const pdfWithJavaScript = () =>
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n',
    'latin1',
  );

export const truncatedPdf = () =>
  Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n', 'latin1');

export const sampleWav = () => {
  const data = Buffer.alloc(32, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

const FIXTURES_DIR = fileURLToPath(
  new URL('../fixtures/audio/', import.meta.url),
);

/**
 * Grabaciones reales pequeñas (tono sintético, sin datos personales),
 * generadas con FFmpeg; ver test/fixtures/audio/README.md.
 */
export const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, name));

export const AUDIO_FIXTURES = {
  webm: {
    bytes: () => fixture('voice-opus.webm'),
    name: 'nota.webm',
    mime: 'audio/webm;codecs=opus',
  },
  wav: {
    bytes: () => fixture('voice.wav'),
    name: 'nota.wav',
    mime: 'audio/wav',
  },
  mp3: {
    bytes: () => fixture('voice.mp3'),
    name: 'nota.mp3',
    mime: 'audio/mpeg',
  },
  m4a: {
    bytes: () => fixture('voice-isom.m4a'),
    name: 'nota.m4a',
    mime: 'audio/mp4',
  },
  ogg: {
    bytes: () => fixture('voice-opus.ogg'),
    name: 'nota.ogg',
    mime: 'audio/ogg',
  },
} as const;

/** Alias: los formatos admitidos se prueban con grabaciones reales. */
export const AUDIO_SAMPLES = AUDIO_FIXTURES;

export const sampleOgg = () => fixture('voice-opus.ogg');
