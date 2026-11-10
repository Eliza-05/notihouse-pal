/**
 * Comprueba un bucket S3-compatible con el adaptador real (`npm run storage:check`).
 *
 * Usa las variables STORAGE_S3_*: escribe un objeto de prueba bajo el prefijo
 * `healthcheck/`, confirma que `If-None-Match` impide sobrescribirlo, lo lee,
 * confirma que no es accesible sin firma y lo borra. No toca PostgreSQL y nunca
 * imprime credenciales.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import {
  StorageObjectExistsError,
  StorageUnavailableError,
} from './file-storage.js';
import { createS3Client, S3FileStorage } from './s3-file-storage.js';

const bucket = process.env.STORAGE_S3_BUCKET?.trim();
const region = process.env.STORAGE_S3_REGION?.trim();
const endpoint = process.env.STORAGE_S3_ENDPOINT?.trim() || undefined;
const forcePathStyle = process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true';

/** Solo el tipo de fallo y el estado HTTP: nunca rutas ni credenciales. */
function describe(error: unknown): string {
  const cause = error instanceof StorageUnavailableError ? error.cause : error;
  const { name, $metadata } = cause as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return `${name ?? 'Error'}, HTTP ${$metadata?.httpStatusCode ?? 'sin respuesta'}`;
}

/** URL del objeto sin firma, según el estilo de direccionamiento configurado. */
function anonymousUrl(key: string): string {
  const base = new URL(endpoint ?? `https://s3.${region}.amazonaws.com`);
  if (forcePathStyle) return `${base.origin}/${bucket}/${key}`;
  return `${base.protocol}//${bucket}.${base.host}/${key}`;
}

async function main(): Promise<void> {
  if (!bucket || !region) {
    throw new Error('Define STORAGE_S3_BUCKET y STORAGE_S3_REGION');
  }
  const client = createS3Client({
    bucket,
    region,
    endpoint,
    accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID?.trim() || undefined,
    secretAccessKey:
      process.env.STORAGE_S3_SECRET_ACCESS_KEY?.trim() || undefined,
    forcePathStyle,
  });
  const storage = new S3FileStorage(client, bucket);
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key = `healthcheck/${now.getUTCFullYear()}/${month}/${randomUUID()}`;
  const content = randomBytes(32).toString('hex');
  const put = (body: string) =>
    storage.put(key, Readable.from([Buffer.from(body)]), {
      contentType: 'text/plain',
      size: Buffer.byteLength(body),
    });

  let written = false;
  try {
    await put(content);
    written = true;
    console.log('✓ Escritura en streaming (PutObject con If-None-Match: *)');
    try {
      await put('sobrescritura');
      throw new Error(
        'El proveedor aceptó sobrescribir: no respeta If-None-Match. Elige otro proveedor o documenta el riesgo',
      );
    } catch (error) {
      if (!(error instanceof StorageObjectExistsError)) throw error;
      console.log('✓ Sobrescritura rechazada (412)');
    }

    const stored = await storage.get(key);
    if ((await text(stored.stream)) !== content) {
      throw new Error('El contenido leído no coincide con el escrito');
    }
    console.log('✓ Lectura en streaming con contenido íntegro');
    if ((await storage.stat(key))?.size !== content.length) {
      throw new Error('HeadObject no informa el tamaño esperado');
    }
    console.log('✓ Metadatos (HeadObject)');

    const anonymous = await fetch(anonymousUrl(key));
    await anonymous.body?.cancel();
    if (anonymous.ok) {
      throw new Error('El objeto es accesible sin firma: el bucket es público');
    }
    console.log(`✓ Sin acceso anónimo (HTTP ${anonymous.status})`);
  } finally {
    if (written) {
      try {
        await storage.removeAfterFailedWrite(key);
        console.log('✓ Objeto de prueba eliminado');
      } catch (error) {
        console.error(
          `✗ No se pudo borrar el objeto de prueba ${key} (${describe(error)})`,
        );
        process.exitCode = 1;
      }
    }
    client.destroy();
  }
}

try {
  await main();
  if (!process.exitCode) console.log('Almacenamiento listo para el backend.');
} catch (error) {
  const message =
    error instanceof StorageUnavailableError
      ? `Proveedor no disponible (${describe(error)})`
      : (error as Error).message;
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}
