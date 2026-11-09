/**
 * Arranca el backend NestJS compilado contra el PostgreSQL QA local.
 * - cwd neutro (.local/qa/run): ConfigModule no encuentra ningún backend/.env.
 * - Entorno construido desde cero: no hereda DATABASE_URL*, JWT_SECRET ni tokens ajenos.
 * Uso: node --env-file=.local/qa/qa.env infra/qa/start-backend.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = resolve(root, '.local', 'qa', 'run');
mkdirSync(resolve(run, 'storage'), { recursive: true });
const need = ['QA_PG_PASSWORD', 'QA_JWT_SECRET', 'QA_N8N_SERVICE_TOKEN'];
for (const k of need) if (!process.env[k]) throw new Error(`Falta ${k}`);

const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
  NODE_ENV: 'development',
  PORT: process.env.QA_BACKEND_PORT ?? '3100',
  FRONTEND_URL: 'http://localhost:5174,http://127.0.0.1:5174',
  DATABASE_URL: `postgresql://notihouse_qa_owner:${encodeURIComponent(process.env.QA_PG_PASSWORD)}@127.0.0.1:55433/notihouse_qa`,
  JWT_SECRET: process.env.QA_JWT_SECRET,
  N8N_SERVICE_TOKEN: process.env.QA_N8N_SERVICE_TOKEN,
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_PATH: resolve(run, 'storage'),
  STORAGE_UPLOAD_TMP_PATH: resolve(run, 'tmp'),
};
const u = new URL(env.DATABASE_URL);
if (u.hostname !== '127.0.0.1' || u.port !== '55433') throw new Error('Destino de base de datos no permitido');
const child = spawn(process.execPath, [resolve(root, 'backend', 'dist', 'main.js')], { cwd: run, env, stdio: 'inherit' });
child.on('exit', (c) => process.exit(c ?? 0));
