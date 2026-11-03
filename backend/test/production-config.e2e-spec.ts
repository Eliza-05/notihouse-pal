import { randomBytes } from 'node:crypto';
import request from 'supertest';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import type { TestApp } from './support/test-app.js';

/**
 * La aplicación con NODE_ENV=production (valores ficticios, PGlite y un pool
 * falso: no se conecta a Neon ni a S3). La configuración se fija ANTES de
 * importar AppModule, porque ConfigModule valida el entorno al cargarse.
 */
describe('Production configuration (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let user: TestUser;
  const password = randomBytes(12).toString('base64url');

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://frontend.example.com',
      DATABASE_URL:
        'postgresql://app_user:sample-password@db.example.com/app?sslmode=require',
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: 'notihouse-private-example',
      STORAGE_S3_REGION: 'us-east-2',
      TRUST_PROXY_HOPS: '1',
    });
    t = await createMigratedDatabase();
    user = await createTestUser(t.db, {
      email: 'prod@config.test',
      password,
      displayName: 'prod',
    });
    const { createTestApp } = await import('./support/test-app.js');
    h = await createTestApp(t.db);
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
  });

  const server = () => h.app.getHttpServer();

  it('does not publish Swagger in production', async () => {
    await request(server()).get('/api/docs').expect(404);
    await request(server()).get('/api/docs-json').expect(404);
  });

  it('only allows the configured frontend origin', async () => {
    const allowed = await request(server())
      .get('/api/v1/health')
      .set('Origin', 'https://frontend.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://frontend.example.com',
    );
    const local = await request(server())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:5173');
    expect(local.headers['access-control-allow-origin']).not.toBe(
      'http://localhost:5173',
    );
  });

  it('rate-limits login per client IP behind exactly one trusted proxy', async () => {
    const login = (ip: string, pass: string) =>
      request(server())
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: user.email, password: pass });
    for (let i = 0; i < 5; i++) {
      await login('203.0.113.10', 'wrong-password').expect(401);
    }
    await login('203.0.113.10', password).expect(429);
    // Otro cliente detrás del mismo proxy no queda bloqueado.
    await login('203.0.113.20', password).expect(200);
    // Un cliente que antepone una IP falsa no evade el límite: con un solo
    // proxy de confianza cuenta la última entrada, la que añade el proxy.
    await login('198.51.100.1, 203.0.113.10', password).expect(429);
  });

  it('hides internal error details', async () => {
    const res = await request(server())
      .get('/api/v1/alerts')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at |jwt malformed/i);
  });
});
