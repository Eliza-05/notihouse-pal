import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  assertStorageKey,
  type FileStorage,
  StorageObjectExistsError,
  StorageObjectNotFoundError,
  type StoredObject,
  StorageUnavailableError,
} from './file-storage.js';

/** Lo único que el adaptador necesita del SDK; permite probarlo con dobles. */
export interface S3SendClient {
  send: S3Client['send'];
}

export interface S3StorageSettings {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
}

/**
 * Crea el cliente oficial sin conectarse: el SDK solo abre conexiones al
 * ejecutar un comando. Sin claves explícitas usa la cadena de credenciales
 * estándar de AWS (variables, rol de la instancia…).
 */
export function createS3Client(settings: S3StorageSettings): S3Client {
  return new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    forcePathStyle: settings.forcePathStyle,
    ...(settings.accessKeyId && settings.secretAccessKey
      ? {
          credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
          },
        }
      : {}),
  });
}

const status = (error: unknown) =>
  error instanceof S3ServiceException
    ? error.$metadata.httpStatusCode
    : (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;

/**
 * Adaptador para almacenamiento de objetos compatible con S3, sobre un bucket
 * privado. No usa ACL públicas ni URLs firmadas: el contenido solo sale por
 * los endpoints autenticados del backend. `IfNoneMatch: '*'` impide
 * sobrescribir (si el proveedor no lo soporta, ver la documentación).
 */
export class S3FileStorage implements FileStorage {
  constructor(
    private readonly client: S3SendClient,
    private readonly bucket: string,
  ) {}

  async put(
    key: string,
    source: Readable,
    meta: { contentType: string; size: number },
  ): Promise<void> {
    assertStorageKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: source,
          ContentLength: meta.size,
          ContentType: meta.contentType,
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (status(error) === 412) throw new StorageObjectExistsError();
      throw new StorageUnavailableError(error);
    }
  }

  async get(key: string): Promise<StoredObject> {
    assertStorageKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!(result.Body instanceof Readable)) {
        throw new StorageUnavailableError();
      }
      return { stream: result.Body, size: result.ContentLength ?? 0 };
    } catch (error) {
      if (status(error) === 404) throw new StorageObjectNotFoundError();
      if (error instanceof StorageUnavailableError) throw error;
      throw new StorageUnavailableError(error);
    }
  }

  async stat(key: string): Promise<{ size: number } | null> {
    assertStorageKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: result.ContentLength ?? 0 };
    } catch (error) {
      if (status(error) === 404) return null;
      throw new StorageUnavailableError(error);
    }
  }

  async removeAfterFailedWrite(key: string): Promise<void> {
    assertStorageKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      throw new StorageUnavailableError(error);
    }
  }
}
