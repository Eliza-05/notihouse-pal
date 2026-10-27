import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { DRIZZLE, PG_POOL } from '../../src/database/database.constants.js';
import type { TestDatabase, TestUser } from './pglite.js';

export interface TestApp {
  app: INestApplication<Server>;
  /** JWT válido firmado por la propia aplicación (evita el rate limiting del login). */
  tokenFor: (user: TestUser) => string;
  /** Cliente HTTP autenticado como `user`. */
  as: (user: TestUser) => AuthedClient;
}

export interface AuthedClient {
  get: (path: string) => request.Test;
  post: (path: string, body?: object) => request.Test;
  patch: (path: string, body?: object) => request.Test;
}

/** Aplicación Nest completa (guard, pipes, filtros) sobre PostgreSQL en memoria. */
export async function createTestApp(
  db: TestDatabase['db'],
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue({ query: vi.fn(), end: vi.fn(), on: vi.fn() })
    .overrideProvider(DRIZZLE)
    .useValue(db);
  const moduleRef = await customize(builder).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>();
  configureApp(app);
  await app.init();

  const jwt = app.get(JwtService);
  const tokenFor = (user: TestUser) => jwt.sign({ sub: user.profileId });
  const as = (user: TestUser): AuthedClient => {
    const auth = `Bearer ${tokenFor(user)}`;
    const server = app.getHttpServer();
    return {
      get: (path) =>
        request(server).get(`/api/v1${path}`).set('Authorization', auth),
      post: (path, body = {}) =>
        request(server)
          .post(`/api/v1${path}`)
          .set('Authorization', auth)
          .send(body),
      patch: (path, body = {}) =>
        request(server)
          .patch(`/api/v1${path}`)
          .set('Authorization', auth)
          .send(body),
    };
  };
  return { app, tokenFor, as };
}
