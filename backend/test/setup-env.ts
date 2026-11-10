import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Secreto JWT aislado para cada ejecución de pruebas. Las variables ya
// definidas tienen prioridad sobre backend/.env, por lo que el secreto real
// nunca se usa en las pruebas.
process.env.JWT_SECRET = randomBytes(32).toString('base64url');
// Token de servicio (n8n) aislado para las pruebas: nunca el de backend/.env.
process.env.N8N_SERVICE_TOKEN = randomBytes(32).toString('base64url');

// Almacenamiento y recepción de archivos en un directorio temporal propio de
// cada archivo de pruebas; nunca en backend/.local ni en un proveedor real.
const filesRoot = join(tmpdir(), `notihouse-test-${randomUUID()}`);
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_PATH = join(filesRoot, 'storage');
process.env.STORAGE_UPLOAD_TMP_PATH = join(filesRoot, 'uploads');
// Límites pequeños para probar el rechazo por tamaño sin generar archivos grandes.
process.env.STORAGE_MAX_PDF_BYTES = String(64 * 1024);
process.env.STORAGE_MAX_AUDIO_BYTES = String(128 * 1024);

afterAll(async () => {
  await rm(filesRoot, { recursive: true, force: true });
});
