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
}

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
