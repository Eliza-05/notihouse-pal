import request from 'supertest';
import {
  createMigratedDatabase,
  type TestDatabase,
} from './support/pglite.js';
import type { TestApp } from './support/test-app.js';

/**
 * D18: `FRONTEND_URL` admite una lista explícita de orígenes separados por
 * comas (p. ej. desarrollo local + Vercel). La configuración se fija ANTES
 * de importar AppModule, porque ConfigModule valida el entorno al cargarse.
 */
describe('CORS with multiple explicit origins (e2e, D18)', () => {
  let t: TestDatabase;
  let h: TestApp;

  beforeAll(async () => {
    Object.assign(process.env, {
      FRONTEND_URL:
        'http://localhost:5173, https://notihouse-pal.vercel.app',
    });
    t = await createMigratedDatabase();
    const { createTestApp } = await import('./support/test-app.js');
    h = await createTestApp(t.db);
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
  });

  const server = () => h.app.getHttpServer();

  it('allows every configured origin', async () => {
    for (const origin of [
      'http://localhost:5173',
      'https://notihouse-pal.vercel.app',
    ]) {
      const res = await request(server())
        .get('/api/v1/health')
        .set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('rejects an origin outside the configured list', async () => {
    const res = await request(server())
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'https://evil.example.com',
    );
  });

  it('answers a request without an Origin header (health checks, curl)', async () => {
    const res = await request(server()).get('/api/v1/health');
    expect(res.status).toBe(200);
  });
});
