export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export interface EnvironmentVariables {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  FRONTEND_URL: string;
}

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

  if (errors.length > 0) {
    throw new Error(
      `Configuración de entorno inválida:\n- ${errors.join('\n- ')}`,
    );
  }

  return {
    NODE_ENV: nodeEnv as NodeEnvironment,
    PORT: port,
    FRONTEND_URL: frontendUrl,
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
