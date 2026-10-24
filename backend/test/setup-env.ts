import { randomBytes } from 'node:crypto';

// Secreto JWT aislado para cada ejecución de pruebas. Las variables ya
// definidas tienen prioridad sobre backend/.env, por lo que el secreto real
// nunca se usa en las pruebas.
process.env.JWT_SECRET = randomBytes(32).toString('base64url');
