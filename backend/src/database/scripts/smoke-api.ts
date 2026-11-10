/**
 * Prueba de humo de SOLO LECTURA contra una API en marcha (`npm run smoke:api`).
 *
 * Variables:
 * - SMOKE_API_URL: base de la API (por defecto http://localhost:3000).
 * - SMOKE_ORIGIN: origen permitido por CORS, igual a FRONTEND_URL (opcional).
 * - SMOKE_CREDENTIALS_FILE: archivo local `nombre<TAB>correo<TAB>contraseña`
 *   (por defecto backend/.local/demo-credentials.txt).
 *
 * El único POST es el login, que no escribe en la base. Nunca imprime
 * credenciales, tokens ni datos personales. Consume 4 intentos del límite de
 * login (5 por minuto e IP): entre ejecuciones, espera un minuto.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.SMOKE_API_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const API = `${BASE}/api/v1`;
const ORIGIN = process.env.SMOKE_ORIGIN?.trim();
const CREDENTIALS =
  process.env.SMOKE_CREDENTIALS_FILE ??
  fileURLToPath(
    new URL('../../../.local/demo-credentials.txt', import.meta.url),
  );
/** Render Free puede tardar cerca de un minuto en despertar. */
const TIMEOUT_MS = 120_000;
const FAKE_TOKEN = 'token-invalido-de-prueba-de-humo';
const BEARER = (token: string) => ({ Authorization: `Bearer ${token}` });

let failures = 0;
function report(ok: boolean, label: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}`);
}

const call = (path: string, init: RequestInit = {}) =>
  fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

async function expectStatus(
  label: string,
  path: string,
  expected: number,
  init: RequestInit = {},
): Promise<void> {
  const res = await call(path, init);
  await res.body?.cancel();
  report(res.status === expected, `${label} → ${res.status}`);
}

/** Cantidad de elementos, sea la respuesta un arreglo o una lista paginada. */
function itemsOf(body: unknown): { id?: string }[] | null {
  if (Array.isArray(body)) return body as { id?: string }[];
  const items = (body as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as { id?: string }[]) : null;
}

async function checkHealth(): Promise<void> {
  const health = await call('/health');
  const text = await health.text();
  report(health.status === 200, `GET /health → ${health.status}`);
  // Neon puede estar suspendido: readiness se reintenta antes de declarar fallo.
  let ready = await call('/health/ready');
  for (let i = 0; i < 3 && ready.status === 503; i += 1) {
    await ready.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    ready = await call('/health/ready');
  }
  const readyText = await ready.text();
  report(ready.status === 200, `GET /health/ready → ${ready.status}`);
  report(
    !/postgres(ql)?:\/\/|neon\.tech|password|secret/i.test(text + readyText),
    'Las rutas de salud no exponen datos de conexión ni secretos',
  );
}

async function checkDocsAndProtection(): Promise<void> {
  const docs = await call(`${BASE}/api/docs-json`);
  await docs.body?.cancel();
  if (BASE.startsWith('https:')) {
    report(docs.status === 404, `Swagger deshabilitado → ${docs.status}`);
  } else {
    console.log(`· Swagger en este entorno → ${docs.status}`);
  }

  const job = `/internal/workflow-jobs/${randomUUID()}`;
  await expectStatus('Ruta privada sin JWT', '/properties', 401);
  await expectStatus('JWT inválido', '/properties', 401, {
    headers: BEARER(FAKE_TOKEN),
  });
  await expectStatus('Ruta interna sin token', job, 401);
  await expectStatus('Token de servicio incorrecto', job, 401, {
    headers: BEARER(FAKE_TOKEN),
  });
}

async function checkCors(): Promise<void> {
  if (!ORIGIN) {
    console.log('· CORS omitido: define SMOKE_ORIGIN para comprobarlo');
    return;
  }
  const preflight = (origin: string, headers: string) =>
    call('/ingestions/documents', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': headers,
      },
    });
  const allowed = await preflight(ORIGIN, 'authorization,content-type');
  const allowedOrigin = allowed.headers.get('access-control-allow-origin');
  const allowedHeaders = (
    allowed.headers.get('access-control-allow-headers') ?? ''
  ).toLowerCase();
  report(
    allowed.status === 204 && allowedOrigin === ORIGIN,
    'CORS: preflight del origen autorizado',
  );
  for (const header of ['authorization', 'content-type', 'x-correlation-id']) {
    report(allowedHeaders.includes(header), `CORS: admite ${header}`);
  }
  for (const method of ['GET', 'POST', 'PATCH']) {
    report(
      (allowed.headers.get('access-control-allow-methods') ?? '').includes(
        method,
      ),
      `CORS: admite ${method}`,
    );
  }
  const foreign = await preflight('https://origen-no-autorizado.example', '');
  report(
    foreign.headers.get('access-control-allow-origin') !==
      'https://origen-no-autorizado.example',
    'CORS: no autoriza otro origen',
  );
  const exposed = await call('/health', { headers: { Origin: ORIGIN } });
  await exposed.body?.cancel();
  report(
    (exposed.headers.get('access-control-expose-headers') ?? '')
      .toLowerCase()
      .includes('x-correlation-id'),
    'CORS: expone X-Correlation-Id',
  );
}

function readCredentials(): { email: string; password: string }[] {
  return readFileSync(CREDENTIALS, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [, email, password] = line.split('\t');
      if (!email || !password) {
        throw new Error('El archivo de credenciales tiene un formato inválido');
      }
      return { email, password };
    });
}

async function checkAccount(
  account: { email: string; password: string },
  index: number,
): Promise<void> {
  const label = `Cuenta ${index + 1}`;
  const login = await call('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  });
  if (login.status !== 200) {
    await login.body?.cancel();
    report(false, `${label}: login → ${login.status}`);
    return;
  }
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = BEARER(accessToken);
  report(true, `${label}: login → 200`);

  const get = async (path: string) => {
    const res = await call(path, { headers });
    const body: unknown = res.ok ? await res.json() : null;
    if (!res.ok) await res.body?.cancel();
    return { status: res.status, body };
  };
  const counts: string[] = [];
  let failed = '';
  const visit = async (path: string) => {
    const { status, body } = await get(path);
    if (status !== 200) failed += ` ${path}=${status}`;
    const items = itemsOf(body);
    if (items) {
      counts.push(`${path.replace(/\/[0-9a-f-]{36}/, '/:id')}=${items.length}`);
    }
    return items;
  };

  await visit('/auth/me');
  await visit('/properties');
  for (const obligation of (await visit('/obligations'))?.slice(0, 1) ?? []) {
    await visit(`/obligations/${obligation.id}/occurrences`);
  }
  for (const rental of (await visit('/rentals'))?.slice(0, 1) ?? []) {
    await visit(`/rentals/${rental.id}/charges`);
  }
  for (const path of [
    '/contracts',
    '/dashboard/summary',
    '/alerts',
    '/attention',
    '/cases',
    '/hitl-requests',
    '/documents',
  ]) {
    await visit(path);
  }
  report(!failed, `${label}: lecturas${failed || ' → 200'}`);
  console.log(`  ${counts.join(' ')}`);

  await expectStatus(
    `${label}: JWT de usuario en ruta interna`,
    `/internal/workflow-jobs/${randomUUID()}`,
    401,
    { headers },
  );
}

async function main(): Promise<void> {
  console.log(`Destino: ${new URL(BASE).host}`);
  await checkHealth();
  await checkDocsAndProtection();
  await checkCors();
  const accounts = readCredentials();
  report(accounts.length === 4, `Cuentas en el archivo: ${accounts.length}`);
  for (const [index, account] of accounts.entries()) {
    await checkAccount(account, index);
  }
}

try {
  await main();
} catch (error) {
  // Solo el mensaje: nunca credenciales ni tokens.
  report(false, (error as Error).message);
}
console.log(
  failures ? `✗ ${failures} comprobaciones fallaron` : '✓ Todo correcto',
);
process.exitCode = failures ? 1 : 0;
