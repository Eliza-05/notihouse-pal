import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertStorageKey,
  type FileStorage,
  StorageObjectExistsError,
  StorageObjectNotFoundError,
  type StoredObject,
  StorageUnavailableError,
} from './file-storage.js';

const isCode = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException | undefined)?.code === code;

/**
 * Adaptador de disco local. SOLO para desarrollo y pruebas: la validación de
 * entorno lo rechaza en producción porque el disco de Render es efímero.
 * El directorio no se sirve por HTTP; los archivos se crean con permisos
 * 0600 (0700 los directorios) donde el sistema operativo los respeta.
 */
export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(
    key: string,
    source: Readable,
    _meta: { contentType: string; size: number },
  ): Promise<void> {
    const target = this.pathFor(key);
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new StorageUnavailableError(error);
    }
    // `wx`: falla si existe, de modo que nunca se sobrescribe un objeto.
    const out = createWriteStream(target, { flags: 'wx', mode: 0o600 });
    try {
      await pipeline(source, out);
    } catch (error) {
      if (isCode(error, 'EEXIST')) throw new StorageObjectExistsError();
      // Escritura parcial: se elimina para no dejar objetos truncados.
      await unlink(target).catch(() => undefined);
      throw new StorageUnavailableError(error);
    }
  }

  async get(key: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    const info = await this.stat(key);
    if (!info) throw new StorageObjectNotFoundError();
    return { stream: createReadStream(path), size: info.size };
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return null;
      throw new StorageUnavailableError(error);
    }
  }

  async removeAfterFailedWrite(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw new StorageUnavailableError(error);
    }
  }

  /** Ruta física de una clave válida, siempre dentro de la raíz. */
  private pathFor(key: string): string {
    assertStorageKey(key);
    const path = resolve(join(this.root, ...key.split('/')));
    if (!path.startsWith(this.root + sep)) {
      throw new Error('Clave de almacenamiento inválida');
    }
    return path;
  }
}
