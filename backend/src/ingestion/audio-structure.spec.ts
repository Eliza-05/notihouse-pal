import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIO_FIXTURES,
  fixture,
  sampleWav,
} from '../../test/support/sample-files.js';
import {
  type AudioFormat,
  mp3FrameLength,
  oggCrc,
  verifyAudioStructure,
} from './audio-structure.js';
import { detectFormat } from './file-policy.js';

describe('verifyAudioStructure', () => {
  let dir: string;
  let n = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'notihouse-audio-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Valida `bytes` como si fuera el temporal recibido. */
  const verify = async (format: AudioFormat, bytes: Buffer) => {
    const path = join(dir, `${n++}.upload`);
    await writeFile(path, bytes);
    return verifyAudioStructure(format, path, bytes.length);
  };

  describe('real recordings (generated with FFmpeg, no personal data)', () => {
    it.each([
      ['webm', 'voice-opus.webm'],
      ['webm', 'voice-live.webm'], // tamaños desconocidos, como MediaRecorder
      ['m4a', 'voice-m4a-brand.m4a'],
      ['m4a', 'voice-isom.m4a'],
      ['m4a', 'voice-mp42.m4a'],
      ['ogg', 'voice-opus.ogg'],
      ['ogg', 'voice-vorbis.ogg'],
      ['mp3', 'voice.mp3'],
      ['wav', 'voice.wav'],
    ] as const)('accepts %s audio (%s)', async (format, name) => {
      const bytes = fixture(name);
      expect(detectFormat(bytes)).toBe(format);
      await expect(verify(format, bytes)).resolves.toBeUndefined();
    });

    it('accepts M4A variants whose ftyp lacks the M4A brand', () => {
      const brands = (name: string) => fixture(name).toString('latin1', 8, 32);
      expect(brands('voice-isom.m4a')).not.toContain('M4A ');
      expect(brands('voice-mp42.m4a')).not.toContain('M4A ');
    });

    it.each([
      ['webm', 'av.webm', /video/],
      ['webm', 'video-only.webm', /video/],
      ['m4a', 'video-only.mp4', /video/],
      ['m4a', 'av.mp4', /video/],
      ['ogg', 'video-theora.ogg', /no es audio/],
    ] as const)(
      'rejects %s with video (%s) as 415',
      async (format, name, reason) => {
        const error = await verify(format, fixture(name)).catch(
          (e: Error) => e,
        );
        expect(error).toBeInstanceOf(UnsupportedMediaTypeException);
        expect((error as Error).message).toMatch(reason);
      },
    );

    it.each(Object.entries(AUDIO_FIXTURES))(
      'rejects a truncated %s recording as 400',
      async (format, sample) => {
        const bytes = sample.bytes();
        const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
        await expect(verify(format as AudioFormat, cut)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      },
    );
  });

  describe('forged and malformed content', () => {
    it.each(['webm', 'm4a', 'ogg', 'wav', 'mp3'] as const)(
      'rejects random bytes declared as %s',
      async (format) => {
        await expect(verify(format, randomBytes(4096))).rejects.toThrow();
      },
    );

    it('rejects a forged M4A header without tracks or data', async () => {
      const ftyp = Buffer.alloc(24);
      ftyp.writeUInt32BE(24, 0);
      ftyp.write('ftypM4A ', 4, 'latin1');
      ftyp.write('M4A isom', 16, 'latin1');
      const forged = Buffer.concat([ftyp, Buffer.alloc(64)]);
      expect(detectFormat(forged)).toBe('m4a');
      await expect(verify('m4a', forged)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a malformed MP4 box size', async () => {
      const bytes = Buffer.from(fixture('voice-isom.m4a'));
      bytes.writeUInt32BE(0xfffffff0, 0); // ftyp mayor que el archivo
      await expect(verify('m4a', bytes)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an MP4 audio track with an unexpected codec', async () => {
      const bytes = Buffer.from(fixture('voice-isom.m4a'));
      const at = bytes.indexOf('mp4a', 0, 'latin1');
      bytes.write('xyz1', at, 'latin1');
      await expect(verify('m4a', bytes)).rejects.toThrow(/códec/);
    });

    it('rejects a forged WebM header without tracks', async () => {
      const forged = Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]),
        Buffer.from('webm', 'latin1'),
        Buffer.from([
          0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
          0xff,
        ]),
        Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x80]),
      ]);
      expect(detectFormat(forged)).toBe('webm');
      await expect(verify('webm', forged)).rejects.toThrow(
        /antes de la descripción de pistas/,
      );
    });

    it('rejects an Ogg file with a corrupted page (CRC)', async () => {
      const bytes = Buffer.from(fixture('voice-opus.ogg'));
      bytes[40] = bytes[40]! ^ 0xff;
      await expect(verify('ogg', bytes)).rejects.toThrow(/CRC/);
    });

    it('rejects a forged Ogg header (only the "OpusHead" string)', async () => {
      const forged = Buffer.concat([
        Buffer.from('OggS', 'latin1'),
        Buffer.alloc(24),
        Buffer.from('OpusHead', 'latin1'),
        Buffer.alloc(32),
      ]);
      expect(detectFormat(forged)).toBe('ogg');
      await expect(verify('ogg', forged)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a WAV with inconsistent format or without samples', async () => {
      const wav = sampleWav();
      const badRate = Buffer.from(wav);
      badRate.writeUInt32LE(12345, 28); // byteRate incoherente
      await expect(verify('wav', badRate)).rejects.toThrow(/incoherentes/);
      const noData = Buffer.from(wav.subarray(0, 36));
      noData.writeUInt32LE(28, 4);
      await expect(verify('wav', noData)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an MP3 with only an ID3 tag, or with junk after the frames', async () => {
      const onlyTag = Buffer.concat([
        Buffer.from('ID3', 'latin1'),
        Buffer.from([4, 0, 0, 0, 0, 0, 0]),
        Buffer.from([0xff, 0xfb, 0x90, 0x64]),
        Buffer.alloc(64),
      ]);
      await expect(verify('mp3', onlyTag)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const junk = Buffer.concat([
        fixture('voice.mp3'),
        Buffer.from('<script>alert(1)</script>'),
      ]);
      await expect(verify('mp3', junk)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('primitives', () => {
    it('computes the Ogg CRC of a real page', async () => {
      const bytes = await readFile(
        join(__dirname, '../../test/fixtures/audio/voice-opus.ogg'),
      );
      const segments = bytes[26]!;
      const length =
        27 +
        segments +
        [...bytes.subarray(27, 27 + segments)].reduce((a, b) => a + b, 0);
      expect(oggCrc(bytes.subarray(0, length))).toBe(bytes.readUInt32LE(22));
    });

    it('computes MPEG layer III frame lengths', () => {
      expect(mp3FrameLength(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe(417); // 128k 44.1k
      expect(mp3FrameLength(Buffer.from([0xff, 0xfb, 0x92, 0x64]))).toBe(418); // + relleno
      expect(mp3FrameLength(Buffer.from([0xff, 0xfd, 0x90, 0x64]))).toBeNull(); // capa II
      expect(mp3FrameLength(Buffer.from([0xff, 0xfb, 0xf0, 0x64]))).toBeNull(); // bitrate inválido
    });
  });
});
