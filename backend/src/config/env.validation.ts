import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeConnectionString } from '../database/connection-string.js';

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export interface EnvironmentVariables {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  FRONTEND_URL: string;
  /** Cadena de Neon con pooling. Opcional solo en `test`. */
  DATABASE_URL?: string;
  /** Secreto HS256 de los JWT. Opcional solo en `test`. */
  JWT_SECRET?: string;
  /**
   * Token Bearer del servicio de automatización (n8n) para las rutas
   * internas. Obligatorio en `production`; sin él, las rutas internas
   * rechazan toda solicitud.
   */
  N8N_SERVICE_TOKEN?: string;
  /** Almacenamiento privado de archivos: `local` (solo desarrollo/pruebas) o `s3`. */
  STORAGE_DRIVER: StorageDriver;
  /** Directorio absoluto del adaptador local (por defecto `<cwd>/.local/storage`). */
  STORAGE_LOCAL_PATH: string;
  /** Directorio temporal de recepción multipart (se vacía tras cada solicitud). */
  STORAGE_UPLOAD_TMP_PATH: string;
  STORAGE_MAX_PDF_BYTES: number;
  STORAGE_MAX_AUDIO_BYTES: number;
  STORAGE_S3_BUCKET?: string;
  STORAGE_S3_REGION?: string;
  STORAGE_S3_ENDPOINT?: string;
  STORAGE_S3_ACCESS_KEY_ID?: string;
  STORAGE_S3_SECRET_ACCESS_KEY?: string;
  STORAGE_S3_FORCE_PATH_STYLE: boolean;
}

export const STORAGE_DRIVERS = ['local', 's3'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

const MIB = 1024 * 1024;
/** Valores iniciales del MVP y techos que no se pueden superar por configuración. */
export const UPLOAD_LIMITS = {
  pdf: { default: 10 * MIB, max: 50 * MIB },
  audio: { default: 25 * MIB, max: 100 * MIB },
} as const;

/** Equivale a 32 bytes aleatorios codificados en base64url. */
export const JWT_SECRET_MIN_LENGTH = 43;

const WEAK_JWT_SECRETS =
  /^(changeme|secret|password|jwt[_-]?secret|test|example)/i;

const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  FRONTEND_URL: 'http://localhost:5173',
} as const;

/**
 * Valida las variables de entorno al arrancar la aplicación.
 * Lanza un error descriptivo si algún valor es inválido, para que el proceso
 * falle de inmediato en lugar de ejecutarse con una configuración incorrecta.
 */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const errors: string[] = [];

  const nodeEnv = readString(config, 'NODE_ENV') ?? DEFAULTS.NODE_ENV;
  if (!NODE_ENVIRONMENTS.includes(nodeEnv as NodeEnvironment)) {
    errors.push(
      `NODE_ENV debe ser uno de: ${NODE_ENVIRONMENTS.join(', ')} (recibido: "${nodeEnv}")`,
    );
  }

  const rawPort = readString(config, 'PORT') ?? DEFAULTS.PORT;
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    errors.push(
      `PORT debe ser un entero entre 1 y 65535 (recibido: "${rawPort}")`,
    );
  }

  const frontendUrl =
    readString(config, 'FRONTEND_URL') ?? DEFAULTS.FRONTEND_URL;
  if (!isHttpOrigin(frontendUrl)) {
    errors.push(
      `FRONTEND_URL debe ser un origen http(s) válido, sin ruta (recibido: "${frontendUrl}")`,
    );
  }

  // El mensaje de error nunca incluye el valor, porque contiene credenciales.
  const databaseUrl = readString(config, 'DATABASE_URL');
  if (databaseUrl) {
    try {
      normalizeConnectionString(databaseUrl, 'DATABASE_URL');
    } catch (error) {
      errors.push((error as Error).message);
    }
  } else if (nodeEnv !== 'test') {
    errors.push('DATABASE_URL es obligatoria fuera del entorno de pruebas');
  }

  // El mensaje nunca incluye el valor del secreto.
  const jwtSecret = readString(config, 'JWT_SECRET');
  if (jwtSecret) {
    if (
      jwtSecret.length < JWT_SECRET_MIN_LENGTH ||
      WEAK_JWT_SECRETS.test(jwtSecret) ||
      new Set(jwtSecret).size < 16
    ) {
      errors.push(
        `JWT_SECRET es insegura: usa al menos ${JWT_SECRET_MIN_LENGTH} caracteres aleatorios (32 bytes)`,
      );
    }
  } else if (nodeEnv !== 'test') {
    errors.push('JWT_SECRET es obligatoria fuera del entorno de pruebas');
  }

  // El mensaje nunca incluye el valor del token.
  const serviceToken = readString(config, 'N8N_SERVICE_TOKEN');
  if (serviceToken) {
    if (
      serviceToken.length < JWT_SECRET_MIN_LENGTH ||
      WEAK_JWT_SECRETS.test(serviceToken) ||
      new Set(serviceToken).size < 16
    ) {
      errors.push(
        `N8N_SERVICE_TOKEN es insegura: usa al menos ${JWT_SECRET_MIN_LENGTH} caracteres aleatorios (32 bytes)`,
      );
    }
    if (serviceToken === jwtSecret) {
      errors.push('N8N_SERVICE_TOKEN no puede ser igual a JWT_SECRET');
    }
  } else if (nodeEnv === 'production') {
    errors.push('N8N_SERVICE_TOKEN es obligatoria en producción');
  }

  const storage = validateStorage(config, nodeEnv, errors);

  if (errors.length > 0) {
    throw new Error(
      `Configuración de entorno inválida:\n- ${errors.join('\n- ')}`,
    );
  }

  return {
    NODE_ENV: nodeEnv as NodeEnvironment,
    PORT: port,
    FRONTEND_URL: frontendUrl,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    N8N_SERVICE_TOKEN: serviceToken,
    ...storage,
  };
}

type StorageSettings = Pick<
  EnvironmentVariables,
  | 'STORAGE_DRIVER'
  | 'STORAGE_LOCAL_PATH'
  | 'STORAGE_UPLOAD_TMP_PATH'
  | 'STORAGE_MAX_PDF_BYTES'
  | 'STORAGE_MAX_AUDIO_BYTES'
  | 'STORAGE_S3_BUCKET'
  | 'STORAGE_S3_REGION'
  | 'STORAGE_S3_ENDPOINT'
  | 'STORAGE_S3_ACCESS_KEY_ID'
  | 'STORAGE_S3_SECRET_ACCESS_KEY'
  | 'STORAGE_S3_FORCE_PATH_STYLE'
>;

/**
 * En producción solo se admite almacenamiento de objetos (`s3`): el disco de
 * Render es efímero y no puede conservar facturas ni audios. Los mensajes
 * nunca incluyen credenciales.
 */
function validateStorage(
  config: Record<string, unknown>,
  nodeEnv: string,
  errors: string[],
): StorageSettings {
  const production = nodeEnv === 'production';
  const rawDriver = readString(config, 'STORAGE_DRIVER');
  const driver = (rawDriver ?? (production ? undefined : 'local')) as
    StorageDriver | undefined;
  if (!driver) {
    errors.push('STORAGE_DRIVER es obligatoria en producción (usa "s3")');
  } else if (!STORAGE_DRIVERS.includes(driver)) {
    errors.push(
      `STORAGE_DRIVER debe ser uno de: ${STORAGE_DRIVERS.join(', ')} (recibido: "${driver}")`,
    );
  } else if (driver === 'local' && production) {
    errors.push(
      'STORAGE_DRIVER=local no está permitido en producción: el disco del servidor es efímero',
    );
  }

  const localPath = resolve(
    readString(config, 'STORAGE_LOCAL_PATH') ?? '.local/storage',
  );
  if (!isAbsolute(localPath)) {
    errors.push('STORAGE_LOCAL_PATH debe resolverse a una ruta absoluta');
  }

  const maxBytes = (key: string, limits: { default: number; max: number }) => {
    const raw = readString(config, key);
    if (raw === undefined) return limits.default;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < 1 || value > limits.max) {
      errors.push(`${key} debe ser un entero entre 1 y ${limits.max}`);
      return limits.default;
    }
    return value;
  };

  const bucket = readString(config, 'STORAGE_S3_BUCKET');
  const region = readString(config, 'STORAGE_S3_REGION');
  const endpoint = readString(config, 'STORAGE_S3_ENDPOINT');
  const accessKeyId = readString(config, 'STORAGE_S3_ACCESS_KEY_ID');
  const secretAccessKey = readString(config, 'STORAGE_S3_SECRET_ACCESS_KEY');
  const forcePathStyle = readString(config, 'STORAGE_S3_FORCE_PATH_STYLE');
  if (driver === 's3') {
    if (!bucket)
      errors.push('STORAGE_S3_BUCKET es obligatoria con STORAGE_DRIVER=s3');
    if (!region)
      errors.push('STORAGE_S3_REGION es obligatoria con STORAGE_DRIVER=s3');
    if (endpoint) {
      let url: URL | null = null;
      try {
        url = new URL(endpoint);
      } catch {
        // se informa abajo
      }
      const allowed = production ? ['https:'] : ['https:', 'http:'];
      if (
        !url ||
        !allowed.includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        errors.push(
          `STORAGE_S3_ENDPOINT debe ser una URL ${production ? 'https' : 'http(s)'} sin credenciales`,
        );
      }
    }
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      errors.push(
        'STORAGE_S3_ACCESS_KEY_ID y STORAGE_S3_SECRET_ACCESS_KEY deben definirse juntas',
      );
    }
  }
  if (
    forcePathStyle !== undefined &&
    !['true', 'false'].includes(forcePathStyle)
  ) {
    errors.push('STORAGE_S3_FORCE_PATH_STYLE debe ser "true" o "false"');
  }

  return {
    STORAGE_DRIVER: driver ?? 'local',
    STORAGE_LOCAL_PATH: localPath,
    STORAGE_UPLOAD_TMP_PATH: resolve(
      readString(config, 'STORAGE_UPLOAD_TMP_PATH') ??
        join(tmpdir(), 'notihouse-uploads'),
    ),
    STORAGE_MAX_PDF_BYTES: maxBytes('STORAGE_MAX_PDF_BYTES', UPLOAD_LIMITS.pdf),
    STORAGE_MAX_AUDIO_BYTES: maxBytes(
      'STORAGE_MAX_AUDIO_BYTES',
      UPLOAD_LIMITS.audio,
    ),
    STORAGE_S3_BUCKET: bucket,
    STORAGE_S3_REGION: region,
    STORAGE_S3_ENDPOINT: endpoint,
    STORAGE_S3_ACCESS_KEY_ID: accessKeyId,
    STORAGE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    STORAGE_S3_FORCE_PATH_STYLE: forcePathStyle === 'true',
  };
}

function readString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value
    );
  } catch {
    return false;
  }
}
