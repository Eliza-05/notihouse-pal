import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import request from 'supertest';
import type { TestUser } from './support/pglite.js';
import {
  createProcessWorld,
  type ProcessWorld,
} from './support/process-fixtures.js';
import { samplePdf, truncatedPdf } from './support/sample-files.js';

/**
 * Regresión de la Fase 4.2E.1: el temporal de recepción debe estar eliminado
 * ANTES de que el cliente reciba la respuesta. Se simula un disco lento
 * retrasando `unlink` (como ocurre con E/S saturada o un antivirus que retiene
 * el archivo): si la limpieza no se espera, el temporal sigue en disco cuando
 * llega la respuesta.
 */
const fsDelay = vi.hoisted(() => ({ unlinkMs: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (fsDelay.unlinkMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fsDelay.unlinkMs));
      }
      return actual.unlink(...args);
    },
  };
});

describe('Upload temp-file cleanup ordering (e2e)', () => {
  let w: ProcessWorld;
  const UPLOADS = process.env.STORAGE_UPLOAD_TMP_PATH!;

  const pendingTemps = async () => {
    try {
      return (await readdir(UPLOADS)).filter((f) => f.endsWith('.upload'));
    } catch {
      return [];
    }
  };

  const upload = (user: TestUser, bytes: Buffer) =>
    request(w.h.app.getHttpServer())
      .post('/api/v1/ingestions/documents')
      .set('Authorization', `Bearer ${w.h.tokenFor(user)}`)
      .field('obligationId', w.lauraObligation)
      .attach('file', bytes, {
        filename: 'factura.pdf',
        contentType: 'application/pdf',
      });

  beforeAll(async () => {
    w = await createProcessWorld();
  }, 60_000);

  afterAll(async () => {
    fsDelay.unlinkMs = 0;
    await w.h.app.close();
    await w.t.client.close();
  });

  beforeEach(() => {
    fsDelay.unlinkMs = 300;
  });

  it('removes the temp file before responding to an accepted upload', async () => {
    await upload(w.laura, samplePdf(`Factura ${randomUUID()}`)).expect(201);
    expect(await pendingTemps()).toEqual([]);
  });

  it('removes the temp file before responding to a rejected upload', async () => {
    await upload(w.laura, truncatedPdf()).expect(400);
    expect(await pendingTemps()).toEqual([]);
  });
});
