import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  newStorageKey,
  StorageObjectExistsError,
  StorageObjectNotFoundError,
  StorageUnavailableError,
} from './file-storage.js';
import { createS3Client, S3FileStorage } from './s3-file-storage.js';

const httpError = (status: number) =>
  Object.assign(new Error(`status ${status}`), {
    $metadata: { httpStatusCode: status },
  });

/** Doble del cliente S3: registra los comandos y nunca usa la red. */
function fakeClient(handler: (command: unknown) => unknown) {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (command: unknown) => {
      sent.push(command);
      return handler(command);
    }),
  };
}

describe('S3FileStorage (contract, no network)', () => {
  const bucket = 'notihouse-private-example';
  const body = () => Readable.from([Buffer.from('x')]);

  it('puts privately, without overwriting, with length and type', async () => {
    const client = fakeClient(() => ({}));
    const storage = new S3FileStorage(client as never, bucket);
    const key = newStorageKey('documents');
    await storage.put(key, body(), { contentType: 'application/pdf', size: 1 });
    const command = client.sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: bucket,
      Key: key,
      ContentLength: 1,
      ContentType: 'application/pdf',
      IfNoneMatch: '*',
    });
    expect(command.input).not.toHaveProperty('ACL');
  });

  it('maps provider responses to storage errors without leaking details', async () => {
    const key = newStorageKey('voice');
    const meta = { contentType: 'audio/ogg', size: 1 };

    const exists = new S3FileStorage(
      fakeClient(() => Promise.reject(httpError(412))) as never,
      bucket,
    );
    await expect(exists.put(key, body(), meta)).rejects.toBeInstanceOf(
      StorageObjectExistsError,
    );

    const missing = new S3FileStorage(
      fakeClient(() => Promise.reject(httpError(404))) as never,
      bucket,
    );
    await expect(missing.get(key)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
    expect(await missing.stat(key)).toBeNull();

    const secret = 'AKIA-should-never-leak';
    const down = new S3FileStorage(
      fakeClient(() =>
        Promise.reject(new Error(`denied for ${secret}`)),
      ) as never,
      bucket,
    );
    const error = await down.put(key, body(), meta).catch((e: Error) => e);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect((error as Error).message).not.toContain(secret);
  });

  it('streams objects and compensates with a delete', async () => {
    const key = newStorageKey('documents');
    const client = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([Buffer.from('data')]), ContentLength: 4 };
      }
      if (command instanceof HeadObjectCommand) return { ContentLength: 4 };
      return {};
    });
    const storage = new S3FileStorage(client as never, bucket);
    expect((await storage.get(key)).size).toBe(4);
    expect(await storage.stat(key)).toEqual({ size: 4 });
    await storage.removeAfterFailedWrite(key);
    expect(client.sent.at(-1)).toBeInstanceOf(DeleteObjectCommand);
  });

  it('rejects manipulated keys before calling the provider', async () => {
    const client = fakeClient(() => ({}));
    const storage = new S3FileStorage(client as never, bucket);
    await expect(storage.get('../other-tenant/file')).rejects.toThrow(
      'Clave de almacenamiento inválida',
    );
    expect(client.send).not.toHaveBeenCalled();
  });

  it('builds the official client without opening connections', async () => {
    const client = createS3Client({
      bucket,
      region: 'us-east-2',
      forcePathStyle: false,
    });
    expect(await client.config.region()).toBe('us-east-2');
    expect(await client.config.requestChecksumCalculation()).toBe(
      'WHEN_REQUIRED',
    );
    expect(await client.config.responseChecksumValidation()).toBe(
      'WHEN_REQUIRED',
    );
    client.destroy();
  });
});
