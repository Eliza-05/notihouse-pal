import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { type FileHandle, open } from 'node:fs/promises';
import type { FileFormat } from './file-policy.js';

/**
 * Validación estructural de notas de voz sobre el temporal ya recibido.
 *
 * Recorre la estructura del contenedor (cajas MP4, elementos EBML, páginas
 * Ogg, chunks RIFF, tramas MPEG) leyendo por desplazamiento, sin cargar el
 * archivo en memoria, y exige que TODAS las pistas sean de audio con un
 * códec admitido. No decodifica el audio ni equivale a un antimalware: un
 * archivo estructuralmente correcto puede contener audio corrupto.
 */

export type AudioFormat = Exclude<FileFormat, 'pdf'>;

/** Marcas `ftyp` de contenedores ISO BMFF que pueden llevar una nota de voz. */
export const MP4_AUDIO_BRANDS = new Set([
  'M4A ',
  'M4B ',
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
]);
const MP4_AUDIO_CODECS = new Set(['mp4a', 'alac', 'Opus', 'fLaC']);
const WEBM_AUDIO_CODECS = new Set(['A_OPUS', 'A_VORBIS']);

const MAX_MP4_BOXES = 256;
/** La caja `moov` de una nota de voz es pequeña; un índice enorme se rechaza. */
const MAX_MOOV_BYTES = 4 * 1024 * 1024;
const MAX_WEBM_ELEMENTS = 512;
const MAX_WEBM_TRACKS_BYTES = 64 * 1024;

const unsupported = (detail: string) =>
  new UnsupportedMediaTypeException(
    `La nota de voz no es un audio admitido: ${detail}`,
  );
const malformed = (detail: string) =>
  new BadRequestException(
    `El archivo de audio está mal formado o truncado: ${detail}`,
  );

const BLOCK = 64 * 1024;

/**
 * Lectura por desplazamiento acotada al tamaño real del archivo, con un
 * bloque en caché para recorridos secuenciales (páginas Ogg, tramas MP3).
 */
class FileWindow {
  private block: Buffer = Buffer.alloc(0);
  private blockStart = 0;

  constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}

  async read(position: number, length: number): Promise<Buffer> {
    const len = Math.max(0, Math.min(length, this.size - position));
    if (len === 0) return Buffer.alloc(0);
    const offset = position - this.blockStart;
    if (offset >= 0 && offset + len <= this.block.length) {
      return this.block.subarray(offset, offset + len);
    }
    if (len <= BLOCK) {
      const size = Math.min(BLOCK, this.size - position);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await this.handle.read(buffer, 0, size, position);
      this.block = buffer.subarray(0, bytesRead);
      this.blockStart = position;
      return this.block.subarray(0, Math.min(len, bytesRead));
    }
    const buffer = Buffer.alloc(len);
    const { bytesRead } = await this.handle.read(buffer, 0, len, position);
    return buffer.subarray(0, bytesRead);
  }
}

export async function verifyAudioStructure(
  format: AudioFormat,
  path: string,
  size: number,
): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const file = new FileWindow(handle, size);
    switch (format) {
      case 'm4a':
        return await verifyMp4(file);
      case 'webm':
        return await verifyWebm(file);
      case 'ogg':
        return await verifyOgg(file);
      case 'wav':
        return await verifyWav(file);
      case 'mp3':
        return await verifyMp3(file);
    }
  } finally {
    await handle.close();
  }
}

// --------------------------------------------------------------- MP4 / M4A

interface Box {
  type: string;
  start: number;
  end: number;
}

/** Cajas hijas dentro de `buf[start, end)`, con límites estrictos. */
function childBoxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const boxes: Box[] = [];
  let pos = start;
  while (pos < end) {
    if (end - pos < 8) throw malformed('caja MP4 incompleta');
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (end - pos < 16) throw malformed('caja MP4 incompleta');
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) {
      throw malformed('tamaño de caja MP4 inválido');
    }
    boxes.push({ type, start: pos + header, end: pos + size });
    if (boxes.length > MAX_MP4_BOXES) throw malformed('demasiadas cajas MP4');
    pos += size;
  }
  return boxes;
}

const child = (buf: Buffer, parent: Box, type: string) =>
  childBoxes(buf, parent.start, parent.end).find((b) => b.type === type);

async function verifyMp4(file: FileWindow): Promise<void> {
  let offset = 0;
  let count = 0;
  let moov: Buffer | null = null;
  let mdat = false;
  while (offset < file.size) {
    if (++count > MAX_MP4_BOXES) throw malformed('demasiadas cajas MP4');
    const head = await file.read(offset, 16);
    if (head.length < 8) throw malformed('caja MP4 incompleta');
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let header = 8;
    if (!/^[\x20-\x7e]{4}$/.test(type))
      throw malformed('tipo de caja inválido');
    if (size === 1) {
      if (head.length < 16) throw malformed('caja MP4 incompleta');
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < header) throw malformed('tamaño de caja MP4 inválido');
    if (offset + size > file.size)
      throw malformed('el contenido termina antes de lo declarado');
    if (count === 1 && type !== 'ftyp')
      throw malformed('falta la caja ftyp inicial');

    if (type === 'ftyp') {
      const payload = await file.read(
        offset + header,
        Math.min(size - header, 256),
      );
      const brands = [payload.toString('latin1', 0, 4)];
      for (let i = 8; i + 4 <= payload.length; i += 4) {
        brands.push(payload.toString('latin1', i, i + 4));
      }
      if (!brands.some((b) => MP4_AUDIO_BRANDS.has(b))) {
        throw unsupported('marca de contenedor MP4 no admitida');
      }
    } else if (type === 'moov') {
      if (moov) throw malformed('caja moov duplicada');
      if (size - header > MAX_MOOV_BYTES)
        throw unsupported('índice MP4 demasiado grande');
      moov = await file.read(offset + header, size - header);
    } else if (type === 'mdat' && size > header) {
      mdat = true;
    }
    offset += size;
  }
  if (!moov) throw malformed('falta la caja moov');
  if (!mdat) throw malformed('el archivo no contiene datos de audio (mdat)');

  const traks = childBoxes(moov).filter((b) => b.type === 'trak');
  if (traks.length === 0) throw unsupported('no contiene pistas');
  for (const trak of traks) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!mdia || !hdlr || hdlr.end - hdlr.start < 12) {
      throw malformed('pista sin descripción de medio');
    }
    const handler = moov.toString('latin1', hdlr.start + 8, hdlr.start + 12);
    if (handler !== 'soun') {
      throw unsupported(
        handler === 'vide'
          ? 'contiene una pista de video'
          : `contiene una pista que no es de audio (${handler.trim()})`,
      );
    }
    const minf = child(moov, mdia, 'minf');
    const stbl = minf && child(moov, minf, 'stbl');
    const stsd = stbl && child(moov, stbl, 'stsd');
    if (
      !stsd ||
      stsd.end - stsd.start < 16 ||
      moov.readUInt32BE(stsd.start + 4) < 1
    ) {
      throw malformed('pista de audio sin descripción de códec');
    }
    const codec = moov.toString('latin1', stsd.start + 12, stsd.start + 16);
    if (!MP4_AUDIO_CODECS.has(codec)) {
      throw unsupported(`códec de audio no admitido (${codec.trim()})`);
    }
  }
}

// -------------------------------------------------------------- WebM (EBML)

const EBML_HEADER = 0x1a45dfa3;
const EBML_DOCTYPE = 0x4282;
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const VIDEO = 0xe0;
const TRACK_TYPE_AUDIO = 2;

interface EbmlElement {
  id: number;
  /** `null` = tamaño desconocido (flujos en vivo, p. ej. MediaRecorder). */
  size: number | null;
  dataStart: number;
}

/** Lee la cabecera (ID + tamaño) de un elemento EBML en `buf[pos]`. */
function readEbmlHeader(buf: Buffer, pos: number): EbmlElement {
  const first = buf[pos];
  if (first === undefined || first === 0)
    throw malformed('elemento EBML inválido');
  const idLength = Math.clz32(first) - 23;
  if (idLength > 4 || pos + idLength > buf.length)
    throw malformed('ID EBML inválido');
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + buf[pos + i]!;

  const sizePos = pos + idLength;
  const sizeFirst = buf[sizePos];
  if (sizeFirst === undefined || sizeFirst === 0)
    throw malformed('tamaño EBML inválido');
  const sizeLength = Math.clz32(sizeFirst) - 23;
  if (sizePos + sizeLength > buf.length)
    throw malformed('tamaño EBML incompleto');
  let size = sizeFirst & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = buf[sizePos + i]!;
    allOnes &&= byte === 0xff;
    size = size * 256 + byte;
  }
  return {
    id,
    size: allOnes ? null : size,
    dataStart: sizePos + sizeLength,
  };
}

/** Elementos hijos con tamaño conocido dentro de `buf[start, end)`. */
function ebmlChildren(buf: Buffer, start: number, end: number) {
  const elements: (EbmlElement & { end: number })[] = [];
  let pos = start;
  while (pos < end) {
    const el = readEbmlHeader(buf.subarray(0, end), pos);
    if (el.size === null || el.dataStart + el.size > end) {
      throw malformed('elemento EBML con tamaño inválido');
    }
    elements.push({ ...el, end: el.dataStart + el.size });
    if (elements.length > MAX_WEBM_ELEMENTS)
      throw malformed('demasiados elementos EBML');
    pos = el.dataStart + el.size;
  }
  return elements;
}

const readUInt = (buf: Buffer, start: number, end: number) => {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + buf[i]!;
  return value;
};

async function verifyWebm(file: FileWindow): Promise<void> {
  const header = readEbmlHeader(await file.read(0, 12), 0);
  if (header.id !== EBML_HEADER || header.size === null || header.size > 256) {
    throw malformed('cabecera EBML inválida');
  }
  const headerBuf = await file.read(0, header.dataStart + header.size);
  if (headerBuf.length < header.dataStart + header.size)
    throw malformed('cabecera EBML truncada');
  const docType = ebmlChildren(
    headerBuf,
    header.dataStart,
    headerBuf.length,
  ).find((e) => e.id === EBML_DOCTYPE);
  if (
    !docType ||
    headerBuf.toString('latin1', docType.dataStart, docType.end) !== 'webm'
  ) {
    throw unsupported('el contenedor no es WebM');
  }

  let pos = header.dataStart + header.size;
  const segment = readEbmlHeader(await file.read(pos, 12), 0);
  if (segment.id !== SEGMENT) throw malformed('falta el segmento WebM');
  const segmentStart = pos + segment.dataStart;
  const segmentEnd =
    segment.size === null ? file.size : segmentStart + segment.size;
  if (segmentEnd > file.size)
    throw malformed('el segmento termina antes de lo declarado');

  pos = segmentStart;
  let tracks: Buffer | null = null;
  let elements = 0;
  while (pos < segmentEnd) {
    if (++elements > MAX_WEBM_ELEMENTS)
      throw malformed('demasiados elementos WebM');
    const el = readEbmlHeader(await file.read(pos, 12), 0);
    if (el.id === CLUSTER) {
      if (!tracks)
        throw malformed('datos de audio antes de la descripción de pistas');
      return verifyWebmTracks(tracks);
    }
    if (el.size === null)
      throw malformed('elemento WebM de tamaño desconocido');
    const end = pos + el.dataStart + el.size;
    if (end > segmentEnd)
      throw malformed('el contenido termina antes de lo declarado');
    if (el.id === TRACKS) {
      if (tracks) throw malformed('descripción de pistas duplicada');
      if (el.size > MAX_WEBM_TRACKS_BYTES)
        throw unsupported('descripción de pistas demasiado grande');
      tracks = await file.read(pos + el.dataStart, el.size);
    }
    pos = end;
  }
  throw malformed(tracks ? 'no contiene datos de audio' : 'no contiene pistas');
}

function verifyWebmTracks(tracks: Buffer): void {
  const entries = ebmlChildren(tracks, 0, tracks.length).filter(
    (e) => e.id === TRACK_ENTRY,
  );
  if (entries.length === 0) throw unsupported('no contiene pistas');
  for (const entry of entries) {
    const fields = ebmlChildren(tracks, entry.dataStart, entry.end);
    const type = fields.find((f) => f.id === TRACK_TYPE);
    const codec = fields.find((f) => f.id === CODEC_ID);
    const trackType = type ? readUInt(tracks, type.dataStart, type.end) : null;
    if (fields.some((f) => f.id === VIDEO) || trackType !== TRACK_TYPE_AUDIO) {
      throw unsupported(
        trackType === 1
          ? 'contiene una pista de video'
          : 'contiene una pista que no es de audio',
      );
    }
    const codecId = codec
      ? tracks.toString('latin1', codec.dataStart, codec.end)
      : '';
    if (!WEBM_AUDIO_CODECS.has(codecId)) {
      throw unsupported(`códec de audio no admitido (${codecId || 'ninguno'})`);
    }
  }
}

// --------------------------------------------------------------------- Ogg

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

/** CRC-32 de Ogg (polinomio 0x04C11DB7, sin reflexión), con el campo CRC en cero. */
export function oggCrc(page: Buffer): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i]!;
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc;
}

/** Códec del primer paquete de un flujo lógico (página BOS). */
function oggCodec(packet: Buffer): 'opus' | 'vorbis' | null {
  if (
    packet.length >= 19 &&
    packet.toString('latin1', 0, 8) === 'OpusHead' &&
    packet[8]! >> 4 === 0 &&
    packet[9]! >= 1
  ) {
    return 'opus';
  }
  if (
    packet.length >= 30 &&
    packet[0] === 0x01 &&
    packet.toString('latin1', 1, 7) === 'vorbis' &&
    packet.readUInt32LE(7) === 0 &&
    packet[11]! >= 1 &&
    packet.readUInt32LE(12) > 0 &&
    (packet[29]! & 0x01) === 1
  ) {
    return 'vorbis';
  }
  return null;
}

/**
 * Recorre TODAS las páginas: CRC correcto, un único flujo lógico de audio
 * (Opus o Vorbis) declarado en la primera página, al menos una página de
 * datos y la última marcada como fin de flujo (detecta archivos truncados).
 */
async function verifyOgg(file: FileWindow): Promise<void> {
  let pos = 0;
  let serial: number | null = null;
  let pages = 0;
  let ended = false;
  while (pos < file.size) {
    if (ended) throw malformed('contenido después del fin del flujo Ogg');
    const head = await file.read(pos, 27);
    if (head.length < 27) throw malformed('página Ogg truncada');
    if (head.toString('latin1', 0, 4) !== 'OggS' || head[4] !== 0) {
      throw malformed('página Ogg inválida');
    }
    const segments = head[26]!;
    const table = await file.read(pos + 27, segments);
    if (table.length < segments) throw malformed('página Ogg truncada');
    const total = 27 + segments + table.reduce((sum, n) => sum + n, 0);
    const page = await file.read(pos, total);
    if (page.length < total) throw malformed('página Ogg truncada');
    if (oggCrc(page) !== head.readUInt32LE(22)) {
      throw malformed('CRC de página Ogg incorrecto');
    }
    const pageSerial = head.readUInt32LE(14);
    const flags = head[5]!;
    if (pages === 0) {
      if ((flags & 0x02) === 0)
        throw malformed('falta la cabecera del flujo Ogg');
      if (!oggCodec(page.subarray(27 + segments))) {
        throw unsupported('el flujo Ogg no es audio Opus ni Vorbis');
      }
      serial = pageSerial;
    } else if (pageSerial !== serial || (flags & 0x02) !== 0) {
      throw unsupported('contiene más de un flujo multimedia');
    }
    ended = (flags & 0x04) !== 0;
    pages++;
    pos += total;
  }
  if (pages < 2) throw malformed('no contiene datos después de la cabecera');
  if (!ended)
    throw malformed('el flujo Ogg no termina correctamente (archivo truncado)');
}

// --------------------------------------------------------------------- WAV

async function verifyWav(file: FileWindow): Promise<void> {
  const riff = await file.read(0, 12);
  if (riff.length < 12) throw malformed('cabecera RIFF incompleta');
  const riffSize = riff.readUInt32LE(4);
  if (riffSize !== 0xffffffff && riffSize + 8 > file.size) {
    throw malformed('el contenido termina antes de lo declarado');
  }
  let pos = 12;
  let fmt = false;
  for (let chunks = 0; chunks < 64 && pos + 8 <= file.size; chunks++) {
    const chunk = await file.read(pos, 8);
    const id = chunk.toString('latin1', 0, 4);
    const length = chunk.readUInt32LE(4);
    if (id === 'fmt ') {
      if (length < 16) throw malformed('bloque fmt inválido');
      const f = await file.read(pos + 8, 16);
      if (f.length < 16) throw malformed('bloque fmt truncado');
      verifyWavFormat(f);
      fmt = true;
    } else if (id === 'data') {
      if (!fmt) throw malformed('datos antes del formato');
      if (length === 0) throw malformed('no contiene muestras de audio');
      if (length !== 0xffffffff && pos + 8 + length > file.size) {
        throw malformed('el contenido termina antes de lo declarado');
      }
      return;
    }
    pos += 8 + length + (length & 1);
  }
  throw malformed(fmt ? 'no contiene datos de audio' : 'falta el bloque fmt');
}

function verifyWavFormat(f: Buffer): void {
  const audioFormat = f.readUInt16LE(0);
  const channels = f.readUInt16LE(2);
  const sampleRate = f.readUInt32LE(4);
  const byteRate = f.readUInt32LE(8);
  const blockAlign = f.readUInt16LE(12);
  const bits = f.readUInt16LE(14);
  // PCM, IEEE float, A-law, µ-law y WAVE_FORMAT_EXTENSIBLE.
  if (![1, 3, 6, 7, 0xfffe].includes(audioFormat)) {
    throw unsupported('codificación WAV no admitida');
  }
  if (
    channels < 1 ||
    channels > 8 ||
    sampleRate < 1000 ||
    sampleRate > 384000 ||
    ![8, 16, 24, 32].includes(bits) ||
    blockAlign !== channels * (bits / 8) ||
    byteRate !== sampleRate * blockAlign
  ) {
    throw malformed('parámetros de formato WAV incoherentes');
  }
}

// --------------------------------------------------------------------- MP3

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

/** Longitud de una trama MPEG capa III válida en `h`, o `null`. */
export function mp3FrameLength(h: Buffer): number | null {
  if (h.length < 4 || h[0] !== 0xff || (h[1]! & 0xe0) !== 0xe0) return null;
  const version = (h[1]! >> 3) & 0x03;
  const layer = (h[1]! >> 1) & 0x03;
  const bitrateIndex = h[2]! >> 4;
  const rateIndex = (h[2]! >> 2) & 0x03;
  if (
    version === 1 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    rateIndex === 3
  ) {
    return null;
  }
  const bitrate =
    (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[bitrateIndex]! * 1000;
  const sampleRate = MP3_SAMPLE_RATES[version]![rateIndex]!;
  const padding = (h[2]! >> 1) & 0x01;
  return (
    Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding
  );
}

async function verifyMp3(file: FileWindow): Promise<void> {
  let pos = 0;
  const id3 = await file.read(0, 10);
  if (id3.toString('latin1', 0, 3) === 'ID3') {
    if (
      id3.length < 10 ||
      id3[3]! < 2 ||
      id3[3]! > 4 ||
      id3.subarray(6, 10).some((b) => b >= 0x80)
    ) {
      throw malformed('etiqueta ID3 inválida');
    }
    const tagSize =
      (id3[6]! << 21) | (id3[7]! << 14) | (id3[8]! << 7) | id3[9]!;
    pos = 10 + tagSize + (id3[5]! & 0x10 ? 10 : 0);
  }
  // Tramas MPEG consecutivas y completas hasta el final del archivo (se
  // admite solo una etiqueta ID3v1 de 128 bytes al final).
  let frames = 0;
  while (pos < file.size) {
    if (file.size - pos === 128) {
      const tag = await file.read(pos, 3);
      if (tag.toString('latin1') === 'TAG') break;
    }
    const length = mp3FrameLength(await file.read(pos, 4));
    if (length === null) {
      throw frames === 0
        ? unsupported('no contiene tramas de audio MPEG capa III')
        : malformed('trama MPEG inválida o datos ajenos al audio');
    }
    if (pos + length > file.size) {
      throw malformed('el contenido termina antes de lo declarado');
    }
    frames++;
    pos += length;
  }
  if (frames < 2) throw malformed('no contiene suficientes tramas de audio');
}
