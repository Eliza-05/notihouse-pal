import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { INVALID_CREDENTIALS_MESSAGE } from '../src/auth/auth.constants.js';
import { DRIZZLE, PG_POOL } from '../src/database/database.constants.js';
import { authAccounts } from '../src/database/schema/index.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';

/**
 * Autenticación de extremo a extremo: aplicación Nest completa (guard global,
 * ValidationPipe, throttler) sobre PostgreSQL en memoria con las migraciones
 * versionadas. No se conecta a Neon.
 */
describe('Auth (e2e)', () => {
  let t: TestDatabase;
  let app: INestApplication<Server>;
  let jwt: JwtService;
  let userA: TestUser;
  let userB: TestUser;
  let inactive: TestUser;

  const pw = () => randomBytes(18).toString('base64url');

  beforeAll(async () => {
    t = await createMigratedDatabase();
    userA = await createTestUser(t.db, {
      email: 'user-a@notihouse.test',
      password: pw(),
      displayName: 'Usuario A',
    });
    userB = await createTestUser(t.db, {
      email: 'user-b@notihouse.test',
      password: pw(),
      displayName: 'Usuario B',
    });
    inactive = await createTestUser(t.db, {
      email: 'inactive@notihouse.test',
      password: pw(),
      displayName: 'Inactivo',
      isActive: false,
    });
  }, 60_000);

  afterAll(async () => {
    await t.client.close();
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useValue({ query: vi.fn(), end: vi.fn(), on: vi.fn() })
      .overrideProvider(DRIZZLE)
      .useValue(t.db)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);
  });

  afterEach(async () => {
    await app.close();
  });

  const login = (body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send(body as object);
  const me = (token?: string) => {
    const req = request(app.getHttpServer()).get('/api/v1/auth/me');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const tokenFor = async (user: TestUser) =>
    (await login({ email: user.email, password: user.password }).expect(200))
      .body.accessToken as string;

  describe('POST /api/v1/auth/login', () => {
    it('returns a bearer token and safe user data', async () => {
      const res = await login({
        email: userA.email,
        password: userA.password,
      }).expect(200);

      expect(res.body).toEqual({
        accessToken: expect.any(String),
        tokenType: 'Bearer',
        expiresIn: 1800,
        user: {
          id: userA.profileId,
          email: userA.email,
          displayName: 'Usuario A',
        },
      });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('argon2');
      expect(raw).not.toContain(userA.password);
      expect(raw).not.toMatch(/password/i);
    });

    it('issues a JWT with only standard claims and the profile id', async () => {
      const token = await tokenFor(userA);
      const [header, payload] = token
        .split('.')
        .slice(0, 2)
        .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
      expect(header.alg).toBe('HS256');
      expect(Object.keys(payload).sort()).toEqual([
        'aud',
        'exp',
        'iat',
        'iss',
        'sub',
      ]);
      expect(payload).toMatchObject({
        sub: userA.profileId,
        iss: 'notihouse-pal-api',
        aud: 'notihouse-pal-web',
      });
      expect(payload.exp - payload.iat).toBe(1800);
    });

    it('normalizes the email (case and surrounding spaces)', async () => {
      await login({
        email: '  USER-A@NotiHouse.TEST ',
        password: userA.password,
      }).expect(200);
    });

    it('answers identically for a wrong password, an unknown email and an inactive account', async () => {
      const wrongPassword = await login({
        email: userA.email,
        password: 'wrong-password',
      }).expect(401);
      const unknownEmail = await login({
        email: 'nobody@notihouse.test',
        password: 'whatever',
      }).expect(401);
      const inactiveAccount = await login({
        email: inactive.email,
        password: inactive.password,
      }).expect(401);

      for (const res of [wrongPassword, unknownEmail, inactiveAccount]) {
        expect(res.body).toEqual({
          statusCode: 401,
          message: INVALID_CREDENTIALS_MESSAGE,
          error: 'Unauthorized',
        });
        expect(res.body.accessToken).toBeUndefined();
      }
    });

    it.each([
      ['empty password', { email: 'user-a@notihouse.test', password: '' }],
      ['missing password', { email: 'user-a@notihouse.test' }],
      ['malformed email', { email: 'not-an-email', password: 'x' }],
      ['numeric email', { email: 12345, password: 'x' }],
      [
        'object password',
        { email: 'user-a@notihouse.test', password: { $ne: '' } },
      ],
      [
        'client-chosen owner id',
        {
          email: 'user-a@notihouse.test',
          password: 'x',
          ownerId: randomUUID(),
        },
      ],
      [
        'oversized password',
        { email: 'user-a@notihouse.test', password: 'x'.repeat(257) },
      ],
    ])('rejects invalid input (%s) with 400', async (_case, body) => {
      const res = await login(body).expect(400);
      expect(res.body.accessToken).toBeUndefined();
    });

    it('blocks repeated attempts after 5 per minute (429)', async () => {
      for (let i = 0; i < 5; i++) {
        await login({ email: userA.email, password: `wrong-${i}` }).expect(401);
      }
      await login({ email: userA.email, password: userA.password }).expect(429);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('requires a token', async () => {
      await me().expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', 'Basic abc')
        .expect(401);
    });

    it('returns only the authenticated identity for each user', async () => {
      const [tokenA, tokenB] = [await tokenFor(userA), await tokenFor(userB)];
      expect((await me(tokenA).expect(200)).body).toEqual({
        id: userA.profileId,
        email: userA.email,
        displayName: 'Usuario A',
      });
      expect((await me(tokenB).expect(200)).body).toEqual({
        id: userB.profileId,
        email: userB.email,
        displayName: 'Usuario B',
      });
    });

    it('ignores client-supplied identity parameters', async () => {
      const tokenA = await tokenFor(userA);
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/auth/me?userId=${userB.profileId}&ownerId=${userB.profileId}`,
        )
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-User-Id', userB.profileId)
        .expect(200);
      expect(res.body.id).toBe(userA.profileId);
    });

    it('rejects a token whose payload was modified', async () => {
      const [header, , signature] = (await tokenFor(userA)).split('.');
      const forged = Buffer.from(
        JSON.stringify({
          sub: userB.profileId,
          iss: 'notihouse-pal-api',
          aud: 'notihouse-pal-web',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 1800,
        }),
      ).toString('base64url');
      await me(`${header}.${forged}.${signature}`).expect(401);
    });

    it('rejects a token signed with another secret', async () => {
      const other = new JwtService({
        secret: randomBytes(32).toString('base64url'),
      });
      await me(
        other.sign(
          { sub: userA.profileId },
          {
            issuer: 'notihouse-pal-api',
            audience: 'notihouse-pal-web',
            expiresIn: 600,
          },
        ),
      ).expect(401);
    });

    it('rejects an expired token', async () => {
      const issuedAt = Math.floor(Date.now() / 1000) - 3600;
      await me(jwt.sign({ sub: userA.profileId, iat: issuedAt })).expect(401);
    });

    it.each([
      ['issuer', { issuer: 'someone-else' }],
      ['audience', { audience: 'another-app' }],
    ])('rejects a token with the wrong %s', async (_claim, options) => {
      await me(jwt.sign({ sub: userA.profileId }, options)).expect(401);
    });

    it('rejects an unsigned token (alg: none)', async () => {
      const enc = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      await me(
        `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: userA.profileId, iss: 'notihouse-pal-api', aud: 'notihouse-pal-web', iat: now, exp: now + 600 })}.`,
      ).expect(401);
    });

    it('rejects a valid token for a profile that does not exist', async () => {
      await me(jwt.sign({ sub: randomUUID() })).expect(401);
    });

    it('rejects tokens of an account deactivated after login', async () => {
      const token = await tokenFor(userB);
      await t.db
        .update(authAccounts)
        .set({ isActive: false })
        .where(eq(authAccounts.profileId, userB.profileId));
      try {
        await me(token).expect(401);
      } finally {
        await t.db
          .update(authAccounts)
          .set({ isActive: true })
          .where(eq(authAccounts.profileId, userB.profileId));
      }
    });

    it('rejects tokens issued before the last password change', async () => {
      const token = await tokenFor(userB);
      await t.db
        .update(authAccounts)
        .set({ passwordChangedAt: sql`now() + interval '1 minute'` })
        .where(eq(authAccounts.profileId, userB.profileId));
      try {
        await me(token).expect(401);
      } finally {
        await t.db
          .update(authAccounts)
          .set({ passwordChangedAt: sql`now() - interval '1 hour'` })
          .where(eq(authAccounts.profileId, userB.profileId));
      }
    });
  });

  describe('public surface', () => {
    it('keeps health public and exposes no registration endpoint', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      for (const path of ['/api/v1/auth/register', '/api/v1/auth/signup']) {
        await request(app.getHttpServer())
          .post(path)
          .send({})
          .expect((res) => {
            expect([401, 404]).toContain(res.status);
          });
      }
    });

    it('documents every route as bearer-protected except health and login', async () => {
      const doc = (
        await request(app.getHttpServer()).get('/api/docs-json').expect(200)
      ).body as {
        paths: Record<string, Record<string, { security?: unknown }>>;
        components: { securitySchemes: Record<string, unknown> };
      };
      const paths = Object.keys(doc.paths);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/v1/auth/login',
          '/api/v1/auth/me',
          '/api/v1/health',
        ]),
      );
      expect(paths.filter((p) => /register|signup/.test(p))).toEqual([]);

      const PUBLIC = new Set(['/api/v1/health', '/api/v1/auth/login']);
      for (const [path, operations] of Object.entries(doc.paths)) {
        for (const [method, operation] of Object.entries(operations)) {
          // Rutas internas: solo el token de servicio; el resto: solo JWT de usuario.
          expect(operation.security, `${method.toUpperCase()} ${path}`).toEqual(
            PUBLIC.has(path)
              ? undefined
              : path.startsWith('/api/v1/internal/')
                ? [{ service: [] }]
                : [{ bearer: [] }],
          );
        }
      }
      expect(doc.components.securitySchemes.bearer).toMatchObject({
        type: 'http',
        scheme: 'bearer',
      });
      expect(doc.components.securitySchemes.service).toMatchObject({
        type: 'http',
        scheme: 'bearer',
      });
      // Swagger documenta el esquema, nunca el valor del token.
      expect(JSON.stringify(doc)).not.toContain(process.env.N8N_SERVICE_TOKEN!);
    });
  });
});
