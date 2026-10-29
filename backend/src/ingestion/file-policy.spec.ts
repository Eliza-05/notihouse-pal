import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  AUDIO_SAMPLES,
  pdfWithJavaScript,
  samplePdf,
  truncatedPdf,
} from '../../test/support/sample-files.js';
import {
  acceptUpload,
  detectFormat,
  HEAD_BYTES,
  PdfActiveContentScanner,
  type ReceivedFile,
  sanitizeFileName,
  TAIL_BYTES,
} from './file-policy.js';

/** Simula lo que entrega el receptor multipart para un contenido dado. */
function received(
  bytes: Buffer,
  originalname: string,
  mimetype: string,
): ReceivedFile {
  const scanner = new PdfActiveContentScanner();
  scanner.push(bytes);
  return {
    originalname,
    mimetype,
    size: bytes.length,
    path: '/unused',
    sha256: '0'.repeat(64),
    head: bytes.subarray(0, HEAD_BYTES),
    tail: bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)),
    pdfActiveContent: scanner.found,
  };
}

describe('file policy', () => {
  it('accepts a minimal PDF and stores the canonical MIME', () => {
    expect(
      acceptUpload(
        'pdf',
        received(samplePdf(), 'Factura Nov.pdf', 'application/pdf'),
      ),
    ).toEqual({
      format: 'pdf',
      mimeType: 'application/pdf',
      fileName: 'Factura Nov.pdf',
    });
  });

  it.each(Object.entries(AUDIO_SAMPLES))(
    'accepts a %s voice note',
    (format, sample) => {
      const accepted = acceptUpload(
        'audio',
        received(sample.bytes(), sample.name, sample.mime),
      );
      expect(accepted.format).toBe(format);
    },
  );

  it.each([
    [
      'HTML disguised as PDF',
      Buffer.from('<html><script>x</script></html>'),
      'a.pdf',
      'application/pdf',
    ],
    ['PDF with wrong extension', samplePdf(), 'a.txt', 'application/pdf'],
    ['PDF with wrong MIME', samplePdf(), 'a.pdf', 'text/html'],
    ['PDF uploaded as audio', samplePdf(), 'a.pdf', 'application/pdf'],
    [
      'SVG',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'a.svg',
      'image/svg+xml',
    ],
    [
      'ZIP',
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
      'a.pdf',
      'application/pdf',
    ],
    [
      'Windows executable',
      Buffer.from('MZ\x90\x00', 'latin1'),
      'a.pdf',
      'application/pdf',
    ],
  ])('rejects %s with 415', (name, bytes, file, mime) => {
    const kind = name === 'PDF uploaded as audio' ? 'audio' : 'pdf';
    expect(() => acceptUpload(kind, received(bytes, file, mime))).toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it.each([
    [
      'WAV renamed to .mp3',
      AUDIO_SAMPLES.wav.bytes(),
      'nota.mp3',
      'audio/mpeg',
    ],
    ['MP3 declared as WAV', AUDIO_SAMPLES.mp3.bytes(), 'nota.wav', 'audio/wav'],
    [
      'audio as octet-stream',
      AUDIO_SAMPLES.ogg.bytes(),
      'nota.ogg',
      'application/octet-stream',
    ],
    [
      'Ogg without audio codec',
      Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]),
      'nota.ogg',
      'audio/ogg',
    ],
  ])('rejects a mismatched audio (%s) with 415', (_c, bytes, file, mime) => {
    expect(() => acceptUpload('audio', received(bytes, file, mime))).toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it('rejects empty files, truncated PDFs and overlong names with 400', () => {
    expect(() =>
      acceptUpload(
        'pdf',
        received(Buffer.alloc(0), 'a.pdf', 'application/pdf'),
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      acceptUpload('pdf', received(truncatedPdf(), 'a.pdf', 'application/pdf')),
    ).toThrow('incompleto');
    expect(() =>
      acceptUpload(
        'pdf',
        received(samplePdf(), `${'a'.repeat(260)}.pdf`, 'application/pdf'),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects PDFs with active content (heuristic)', () => {
    expect(() =>
      acceptUpload(
        'pdf',
        received(pdfWithJavaScript(), 'a.pdf', 'application/pdf'),
      ),
    ).toThrow('contenido activo');
  });

  it('detects active content split across chunks', () => {
    const scanner = new PdfActiveContentScanner();
    scanner.push(Buffer.from('1 0 obj << /S /Java'));
    scanner.push(Buffer.from('Script >>'));
    expect(scanner.found).toBe(true);
    const clean = new PdfActiveContentScanner();
    clean.push(Buffer.from('/JSON /JSomething /Launcher'));
    expect(clean.found).toBe(false);
  });

  it('never detects formats from names, only from content', () => {
    expect(detectFormat(Buffer.from('not a known format'))).toBeNull();
  });

  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\x\\factura.pdf', 'factura.pdf'],
    ['..pdf', 'pdf'],
    ['fac\u0000tura<script>.pdf', 'facturascript.pdf'],
    ['   ', null],
  ])('sanitizes the original name %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });
});
