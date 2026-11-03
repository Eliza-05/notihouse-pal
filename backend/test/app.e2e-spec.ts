import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { PG_POOL } from './../src/database/database.constants.js';

describe('Health (e2e)', () => {
  let app: INestApplication<Server>;
  // Pool falso: cualquier consulta falla, lo que demuestra que /health no usa la base de datos.
  const pool = {
    query: vi.fn().mockRejectedValue(new Error('database must not be used')),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns 200 with liveness payload', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'ok',
      service: 'notihouse-pal-api',
      timestamp: expect.any(String),
    });
    expect(new Date(response.body.timestamp).toISOString()).toBe(
      response.body.timestamp,
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('closes the database pool on shutdown', async () => {
    pool.end.mockClear();
    await app.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
    // afterEach vuelve a cerrar; Nest ignora el segundo cierre.
  });

  it('GET /health without the API prefix returns 404', () => {
    return request(app.getHttpServer()).get('/health').expect(404);
  });

  it('allows CORS only for the configured frontend origin', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );

    const other = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://evil.example.com');
    expect(other.headers['access-control-allow-origin']).not.toBe(
      'http://evil.example.com',
    );
  });

  it('answers CORS preflights only with the methods and headers in use', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/api/v1/alerts')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(preflight.headers['access-control-allow-methods']).toBe(
      'GET,POST,PATCH',
    );
    expect(preflight.headers['access-control-allow-headers']).toBe(
      'Authorization,Content-Type,x-correlation-id',
    );
    expect(
      preflight.headers['access-control-allow-credentials'],
    ).toBeUndefined();

    const foreign = await request(app.getHttpServer())
      .options('/api/v1/alerts')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(foreign.headers['access-control-allow-origin']).not.toBe(
      'https://evil.example.com',
    );

    const simple = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:5173');
    expect(simple.headers['access-control-expose-headers']).toBe(
      'x-correlation-id',
    );
  });

  it('GET /api/v1/health/ready reports PostgreSQL without leaking details', async () => {
    pool.query.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED db.internal:5432 password=secret'),
    );
    const down = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);
    expect(down.body).toMatchObject({
      status: 'unavailable',
      checks: { database: 'unavailable' },
    });
    expect(JSON.stringify(down.body)).not.toMatch(
      /ECONNREFUSED|db\.internal|secret/,
    );

    pool.query.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    const up = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);
    expect(up.body).toMatchObject({
      status: 'ready',
      checks: { database: 'ok' },
    });
    // El liveness sigue sin depender de la base de datos.
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });

  it('serves the Swagger document including the health endpoint', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);

    expect(response.body.paths).toHaveProperty('/api/v1/health');
  });
});
