import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

/** Token de inyección del almacenamiento privado de archivos. */
export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface StoredObject {
  stream: Readable;
  size: number;
}

/**
 * Almacenamiento privado desacoplado del proveedor. Los controladores y
 * servicios de ingesta solo conocen esta interfaz.
 *
 * Las claves las genera el backend (`newStorageKey`); nunca derivan del
 * nombre ni de datos enviados por el cliente. No existe una operación de
 * borrado de negocio: `removeAfterFailedWrite` solo compensa un objeto
 * recién creado cuando la transacción de PostgreSQL no se confirmó.
 */
export interface FileStorage {
  /** Guarda un objeto nuevo; falla con `StorageObjectExistsError` si la clave existe. */
  put(
    key: string,
    source: Readable,
    meta: { contentType: string; size: number },
  ): Promise<void>;
  /** Contenido como stream; `StorageObjectNotFoundError` si no existe. */
  get(key: string): Promise<StoredObject>;
  /** Metadatos técnicos, o `null` si no existe. */
  stat(key: string): Promise<{ size: number } | null>;
  removeAfterFailedWrite(key: string): Promise<void>;
}

export class StorageObjectNotFoundError extends Error {
  constructor() {
    super('El objeto no existe en el almacenamiento');
  }
}

export class StorageObjectExistsError extends Error {
  constructor() {
    super('Ya existe un objeto con esa clave');
  }
}

/** Fallo del proveedor. El mensaje nunca incluye rutas, claves ni credenciales. */
export class StorageUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('El almacenamiento de archivos no está disponible', { cause });
  }
}

/** `<prefijo>/<aaaa>/<mm>/<uuid>`: solo minúsculas, dígitos, `-` y `/`. */
export const STORAGE_KEY_PATTERN = /^[a-z]+\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/;

export function newStorageKey(prefix: 'documents' | 'voice'): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}/${now.getUTCFullYear()}/${month}/${randomUUID()}`;
}

/** Rechaza cualquier clave que no haya generado `newStorageKey` (path traversal incluido). */
export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key)) {
    throw new Error('Clave de almacenamiento inválida');
  }
}
