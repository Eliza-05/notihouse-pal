import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import {
  newStorageKey,
  StorageObjectExistsError,
  StorageObjectNotFoundError,
  StorageUnavailableError,
} from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';

const meta = { contentType: 'application/pdf', size: 5 };

/** Archivos (no directorios) bajo `dir`, recursivamente. */
async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

describe('LocalFileStorage', () => {
  let root: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notihouse-storage-'));
    storage = new LocalFileStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores, stats and streams an object back', async () => {
    const key = newStorageKey('documents');
    await storage.put(key, Readable.from([Buffer.from('hello')]), meta);
    expect(await storage.stat(key)).toEqual({ size: 5 });
    const object = await storage.get(key);
    expect(object.size).toBe(5);
    expect(await text(object.stream)).toBe('hello');
    expect(await readFile(join(root, ...key.split('/')), 'utf8')).toBe('hello');
  });

  it('uses restrictive permissions where the OS supports them', async () => {
    const key = newStorageKey('voice');
    await storage.put(key, Readable.from([Buffer.from('x')]), meta);
    const mode = (await stat(join(root, ...key.split('/')))).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  it('never overwrites an existing object', async () => {
    const key = newStorageKey('documents');
    await storage.put(key, Readable.from([Buffer.from('first')]), meta);
    await expect(
      storage.put(key, Readable.from([Buffer.from('second')]), meta),
    ).rejects.toBeInstanceOf(StorageObjectExistsError);
    expect(await text((await storage.get(key)).stream)).toBe('first');
  });

  it('reports missing objects', async () => {
    const key = newStorageKey('documents');
    expect(await storage.stat(key)).toBeNull();
    await expect(storage.get(key)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
    await expect(storage.removeAfterFailedWrite(key)).resolves.toBeUndefined();
  });

  it.each([
    '../outside',
    'documents/../../etc/passwd',
    '/etc/passwd',
    'documents\\2026\\01\\x',
    'documents/2026/01/not-a-uuid',
    'Documents/2026/01/0b6f5c1e-0000-4000-8000-000000000000',
    '',
  ])('rejects the manipulated key %j', async (key) => {
    await expect(
      storage.put(key, Readable.from([Buffer.from('x')]), meta),
    ).rejects.toThrow('Clave de almacenamiento inválida');
    await expect(storage.get(key)).rejects.toThrow();
    expect(await filesIn(root)).toEqual([]);
  });

  it('removes a partially written object when the source fails', async () => {
    const key = newStorageKey('voice');
    let sent = false;
    const failing = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.alloc(1024, 1));
        } else {
          this.destroy(new Error('connection reset'));
        }
      },
    });
    await expect(storage.put(key, failing, meta)).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(await storage.stat(key)).toBeNull();
    expect(await filesIn(root)).toEqual([]);
  });

  it('compensates a freshly written object', async () => {
    const key = newStorageKey('documents');
    await storage.put(key, Readable.from([Buffer.from('x')]), meta);
    await storage.removeAfterFailedWrite(key);
    expect(await storage.stat(key)).toBeNull();
  });

  it('hides physical paths when the disk fails', async () => {
    // La raíz es un archivo: crear directorios debajo falla.
    const fileRoot = join(root, 'file-not-dir');
    await writeFile(fileRoot, 'x');
    const blocked = new LocalFileStorage(fileRoot);
    const error = await blocked
      .put(newStorageKey('documents'), Readable.from([Buffer.from('x')]), meta)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect((error as Error).message).not.toContain(root);
  });
});
