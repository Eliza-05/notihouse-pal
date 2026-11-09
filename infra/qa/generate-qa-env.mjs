/**
 * Genera .local/qa/qa.env (ignorado por Git) con secretos ALEATORIOS exclusivos
 * del entorno QA local. Nunca imprime valores. No sobrescribe un archivo existente.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = resolve(root, '.local', 'qa', 'qa.env');
if (existsSync(file)) { console.log('qa.env ya existe; no se modifica.'); process.exit(0); }
mkdirSync(dirname(file), { recursive: true });
const r = (n) => randomBytes(n).toString('base64url');
const lines = [
  `QA_PG_PASSWORD=${r(24)}`,
  `QA_JWT_SECRET=${r(48)}`,
  `QA_N8N_SERVICE_TOKEN=${r(48)}`,
  `QA_N8N_OWNER_PASSWORD=${r(12)}Aa1`,
  `QA_USER_PASSWORD_DANIEL=${r(14)}`,
  `QA_USER_PASSWORD_OTHER=${r(14)}`,
];
writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
console.log('qa.env creado (valores no mostrados).');
