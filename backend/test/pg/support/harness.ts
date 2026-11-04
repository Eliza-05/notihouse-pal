import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AppModule } from '../../../src/app.module.js';
import { configureApp } from '../../../src/app.setup.js';
import { hashPassword } from '../../../src/auth/password.js';
import { sessionVersion } from '../../../src/auth/session-version.js';
import { PG_POOL } from '../../../src/database/database.constants.js';
import {
  APP_ROLE,
  assertConnectedTarget,
  type GuardState,
  OWNER_ROLE,
} from '../../../src/database/scripts/concurrency/target-guard.js';

const LOCAL = fileURLToPath(new URL('../../../.local/', import.meta.url));
const EVIDENCE_DIR = `${LOCAL}concurrency/`;
const EVIDENCE_FILE = `${EVIDENCE_DIR}evidence.jsonl`;

export const guardState = (): GuardState =>
  JSON.parse(
    readFileSync(`${EVIDENCE_DIR}guard-state.json`, 'utf8'),
  ) as GuardState;

/** Pool verificado: su primera conexión pasa la barrera antes de cualquier uso. */
export async function guardedPool(
  url: string,
  role: string,
  applicationName: string,
  max = 5,
): Promise<pg.Pool> {
  const pool = new pg.Pool({
    connectionString: url,
    application_name: applicationName,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', () => undefined);
  const client = await pool.connect();
  try {
    await assertConnectedTarget(client, role, guardState());
  } catch (error) {
    client.release();
    await pool.end();
    throw error;
  }
  client.release();
  return pool;
}

export const ownerUrl = () => process.env.CONCURRENCY_TEST_DATABASE_URL_DIRECT!;
export const appUrl = () => process.env.CONCURRENCY_TEST_DATABASE_URL!;

export interface Res {
  status: number;
  // Respuesta JSON de la API (forma variable según la ruta).
  body: any;
  bytes?: Buffer;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Client {
  get(path: string, options?: RequestOptions): Promise<Res>;
  post(path: string, body?: object, options?: RequestOptions): Promise<Res>;
  patch(path: string, body?: object, options?: RequestOptions): Promise<Res>;
  upload(
    path: string,
    file: { name: string; type: string; bytes: Buffer },
    fields?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<Res>;
  download(path: string, options?: RequestOptions): Promise<Res>;
}

const REQUEST_TIMEOUT_MS = 45_000;

const signalOf = (options?: RequestOptions) =>
  options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

export function httpClient(baseUrl: string, authorization?: string): Client {
  const headers = (options?: RequestOptions, json = false) => ({
    ...(authorization ? { Authorization: authorization } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...options?.headers,
  });
  const parse = async (res: Response): Promise<Res> => {
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { text };
    }
    return { status: res.status, body };
  };
  const call = async (
    method: string,
    path: string,
    body?: object,
    options?: RequestOptions,
  ) =>
    parse(
      await fetch(`${baseUrl}${path}`, {
        method,
        headers: headers(options, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signalOf(options),
      }),
    );
  return {
    get: (path, options) => call('GET', path, undefined, options),
    post: (path, body = {}, options) => call('POST', path, body, options),
    patch: (path, body = {}, options) => call('PATCH', path, body, options),
    upload: async (path, file, fields = {}, options) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      form.set(
        'file',
        new Blob([new Uint8Array(file.bytes)], { type: file.type }),
        file.name,
      );
      return parse(
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: headers(options),
          body: form,
          signal: signalOf(options),
        }),
      );
    },
    download: async (path, options) => {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: headers(options),
        signal: signalOf(options),
      });
      if (res.status !== 200) return parse(res);
      return {
        status: 200,
        body: {},
        bytes: Buffer.from(await res.arrayBuffer()),
      };
    },
  };
}

export interface Api {
  name: string;
  app: INestApplication<Server>;
  baseUrl: string;
  pool: pg.Pool;
  service: Client;
  close(): Promise<void>;
}

/**
 * Instancia real de la API: servidor HTTP propio y `pg.Pool` propio de 5
 * conexiones (el valor de producción) con el rol restringido. Las solicitudes
 * van por HTTP. PG_POOL se sustituye por el pool verificado, de modo que
 * backend/.env no puede abrir ninguna conexión.
 */
export async function startApi(
  name: string,
  customize: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<Api> {
  const pool = await guardedPool(
    appUrl(),
    APP_ROLE,
    `notihouse-pal-api-${name}`,
  );
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(pool);
  const moduleRef = await customize(builder).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>({
    logger: false,
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;
  return {
    name,
    app,
    baseUrl,
    pool,
    service: httpClient(baseUrl, `Bearer ${process.env.N8N_SERVICE_TOKEN!}`),
    close: () => app.close(),
  };
}

export interface User {
  profileId: string;
  email: string;
  password: string;
  passwordChangedAt: Date;
  token: string;
  /** Cliente por la instancia A de la API. */
  a: Client;
  /** Cliente por la instancia B (otro proceso lógico, otro pool). */
  b: Client;
}

export interface ClaimedJob {
  id: string;
  claimToken: string;
  jobType: string;
  status: string;
  attempts: number;
  case: { id: string; correlationId: string; status: string };
}

/** Bloqueos en espera de las sesiones de la API, según PostgreSQL. */
const BLOCKED_SQL = `
  SELECT pid, application_name, wait_event
    FROM pg_stat_activity
   WHERE datname = current_database()
     AND application_name LIKE 'notihouse-pal-api%'
     AND wait_event_type = 'Lock'`;

export interface Blocked {
  pid: number;
  application_name: string;
  wait_event: string;
}

export function recordEvidence(label: string, data: object): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  appendFileSync(
    EVIDENCE_FILE,
    `${JSON.stringify({ at: new Date().toISOString(), label, ...data })}\n`,
  );
}

export class Harness {
  private constructor(
    readonly apiA: Api,
    readonly apiB: Api,
    readonly owner: pg.Pool,
  ) {}

  static async start(): Promise<Harness> {
    const owner = await guardedPool(
      ownerUrl(),
      OWNER_ROLE,
      'notihouse-concurrency-owner',
      4,
    );
    const [apiA, apiB] = [await startApi('a'), await startApi('b')];
    return new Harness(apiA, apiB, owner);
  }

  async close(): Promise<void> {
    await this.assertNoOpenTransactions();
    await this.apiA.close();
    await this.apiB.close();
    await this.owner.end();
  }

  /** Ninguna sesión de la API puede quedar con una transacción abierta. */
  async assertNoOpenTransactions(): Promise<void> {
    const rows = await this.sql<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name LIKE 'notihouse-pal-api%'
          AND state LIKE 'idle in transaction%'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  }

  async sql<T extends pg.QueryResultRow = Record<string, any>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.owner.query<T>(text, params)).rows;
  }

  async count(text: string, params: unknown[] = []): Promise<number> {
    const rows = await this.sql<{ n: string }>(text, params);
    return Number(rows[0]!.n);
  }

  audit(action: string, resourceId: string): Promise<number> {
    return this.count(
      `SELECT count(*) AS n FROM audit_events WHERE action = $1 AND metadata->>'resourceId' = $2`,
      [action, resourceId],
    );
  }

  /** Aísla cada prueba de la cola global, solo en esta base descartable. */
  async drainQueue(): Promise<void> {
    await this.sql(
      `UPDATE workflow_jobs SET status = 'cancelled', locked_until = NULL
        WHERE status IN ('pending', 'claimed')`,
    );
  }

  /**
   * El barrido de alertas es global: retira lo abierto por ejecuciones
   * anteriores para que los escenarios no dependan del historial de la base.
   * Solo en esta base descartable; `audit_events` no se toca.
   */
  async retireOpenWork(): Promise<void> {
    await this.drainQueue();
    await this.sql(
      `UPDATE hitl_requests SET status = 'cancelled' WHERE status = 'pending'`,
    );
    await this.sql(
      `UPDATE obligation_occurrences SET status = 'cancelled' WHERE status IN ('pending', 'overdue')`,
    );
    await this.sql(
      `UPDATE rent_charges SET status = 'cancelled' WHERE status IN ('expected', 'pending', 'overdue')`,
    );
    await this.sql(
      `UPDATE alerts SET state = 'resolved', resolved_at = now(), resolution_reason = 'no_longer_applicable' WHERE state = 'active'`,
    );
  }

  async newUser(label = 'user', hashed = false): Promise<User> {
    const email = `${label}-${randomUUID().slice(0, 8)}@concurrency.test`;
    const password = randomBytes(12).toString('base64url');
    const [profile] = await this.sql<{ id: string }>(
      `INSERT INTO profiles (display_name) VALUES ($1) RETURNING id`,
      [`Sintético ${label}`],
    );
    // Sin login real el hash es irrelevante: se reutiliza el de una contraseña
    // aleatoria y argon2 solo se calcula cuando la prueba inicia sesión.
    const hash = hashed
      ? await hashPassword(password)
      : (Harness.sharedHash ??= await hashPassword(
          randomBytes(12).toString('base64url'),
        ));
    const [account] = await this.sql<{ password_changed_at: Date }>(
      `INSERT INTO auth_accounts (profile_id, email, password_hash)
       VALUES ($1, $2, $3) RETURNING password_changed_at`,
      [profile!.id, email, hash],
    );
    const passwordChangedAt = account!.password_changed_at;
    const token = this.apiA.app.get(JwtService).sign({
      sub: profile!.id,
      sv: sessionVersion(profile!.id, passwordChangedAt),
    });
    const auth = `Bearer ${token}`;
    return {
      profileId: profile!.id,
      email,
      password,
      passwordChangedAt,
      token,
      a: httpClient(this.apiA.baseUrl, auth),
      b: httpClient(this.apiB.baseUrl, auth),
    };
  }

  private static sharedHash?: string;

  async obligation(user: User, label = 'Energía'): Promise<string> {
    const res = await user.a.post('/obligations', {
      providerName: `Proveedor ${label} ${randomUUID().slice(0, 8)}`,
      concept: label,
      category: 'other',
      expectedAmount: '1000.00',
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async occurrence(
    user: User,
    obligationId: string,
    dueDate = '2099-01-15',
    periodStart = dueDate.slice(0, 8) + '01',
  ): Promise<string> {
    const res = await user.a.post(`/obligations/${obligationId}/occurrences`, {
      periodStart,
      periodEnd: dueDate,
      dueDate,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async property(user: User): Promise<string> {
    const res = await user.a.post('/properties', {
      name: `Inmueble ${randomUUID().slice(0, 8)}`,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async rental(user: User, propertyId?: string): Promise<string> {
    const res = await user.a.post('/rentals', {
      propertyId: propertyId ?? (await this.property(user)),
      expectedAmount: '1000.00',
      dueDay: 5,
      startsOn: '2020-01-01',
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async charge(
    user: User,
    rentalId: string,
    dueDate = '2099-01-05',
  ): Promise<string> {
    const res = await user.a.post(`/rentals/${rentalId}/charges`, {
      periodStart: `${dueDate.slice(0, 8)}01`,
      periodEnd: `${dueDate.slice(0, 8)}28`,
      dueDate,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async newCase(
    user: User,
    body: object = {},
  ): Promise<{ id: string; correlationId: string; status: string }> {
    const res = await user.a.post('/cases', {
      type: 'household_obligation',
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  claim(workerId: string, body: object = {}, api: Api = this.apiA) {
    return api.service.post('/internal/workflow-jobs/claim', {
      workerId,
      ...body,
    });
  }

  /** Reclama y devuelve el trabajo de ese caso; falla si no aparece. */
  async claimOf(
    caseId: string,
    workerId = 'worker-1',
    body: object = {},
  ): Promise<ClaimedJob> {
    const res = await this.claim(workerId, { limit: 10, ...body });
    expect(res.status).toBe(200);
    const job = (res.body.jobs as ClaimedJob[]).find(
      (j) => j.case.id === caseId,
    );
    expect(job, `trabajo del caso ${caseId}`).toBeDefined();
    return job!;
  }

  async claimedCase(user: User, body: object = {}) {
    const c = await this.newCase(user, body);
    return { c, job: await this.claimOf(c.id) };
  }

  /** Simula el vencimiento del arrendamiento sin tocar el reloj del sistema. */
  expireLease(jobId: string) {
    return this.sql(
      `UPDATE workflow_jobs SET locked_until = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
  }

  makeAvailable(jobId: string) {
    return this.sql(
      `UPDATE workflow_jobs SET available_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
  }

  job(id: string) {
    return this.sql<Record<string, any>>(
      `SELECT * FROM workflow_jobs WHERE id = $1`,
      [id],
    ).then((r) => r[0]!);
  }

  propose(caseId: string, job: ClaimedJob, proposedData: object, extra = {}) {
    return this.apiA.service.post(`/internal/cases/${caseId}/proposals`, {
      jobId: job.id,
      claimToken: job.claimToken,
      source: 'llm',
      proposedData,
      ...extra,
    });
  }

  review(caseId: string, job: ClaimedJob, proposalId?: string, summary = 'R') {
    return this.apiA.service.post(`/internal/cases/${caseId}/hitl-requests`, {
      jobId: job.id,
      claimToken: job.claimToken,
      decisionType: 'data_confirmation',
      ...(proposalId ? { proposalId } : {}),
      options: { summary },
    });
  }

  /** Caso con propuesta `create_obligation_occurrence` y revisión pendiente. */
  async pendingReview(user: User, dueDate = '2099-02-15') {
    const obligationId = await this.obligation(user, 'Aplicación');
    const { c, job } = await this.claimedCase(user, { obligationId });
    const proposal = await this.propose(c.id, job, {
      action: 'create_obligation_occurrence',
      data: {
        obligationId,
        periodStart: `${dueDate.slice(0, 8)}01`,
        periodEnd: `${dueDate.slice(0, 8)}28`,
        dueDate,
      },
    });
    expect(proposal.status).toBe(201);
    const review = await this.review(c.id, job, proposal.body.id as string);
    expect(review.status).toBe(201);
    return {
      caseId: c.id,
      correlationId: c.correlationId,
      obligationId,
      job,
      proposalId: proposal.body.id as string,
      reviewId: review.body.id as string,
      dueDate,
    };
  }

  async approvedProposal(user: User, dueDate?: string) {
    const r = await this.pendingReview(user, dueDate);
    const res = await user.a.post(`/hitl-requests/${r.reviewId}/decision`, {
      decision: 'approved',
    });
    expect(res.status).toBe(200);
    return r;
  }

  async blockedNow(): Promise<Blocked[]> {
    return this.sql<Blocked>(BLOCKED_SQL);
  }

  /** Espera a que PostgreSQL muestre al menos `n` sesiones bloqueadas. */
  async waitBlocked(n: number, timeoutMs = 15_000): Promise<Blocked[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const blocked = await this.blockedNow();
      if (blocked.length >= n) return blocked;
      if (Date.now() > deadline) {
        throw new Error(
          `Barrera: ${blocked.length} sesiones bloqueadas de ${n} esperadas`,
        );
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /**
   * Barrera determinista: una conexión de control bloquea una fila, se lanzan
   * las solicitudes, se ESPERA a que PostgreSQL las muestre en cola sobre un
   * bloqueo y se libera. Así las transacciones compiten de verdad, sin depender
   * de temporizadores. Devuelve las sesiones que estuvieron bloqueadas.
   */
  async behindLock<T>(
    label: string,
    lock: { table: string; id: string },
    expectedBlocked: number,
    fire: () => Promise<T>[],
  ): Promise<{ results: T[]; blocked: Blocked[] }> {
    const control = await this.owner.connect();
    let promises: Promise<T>[] = [];
    let blocked: Blocked[] = [];
    let barrierError: unknown = null;
    try {
      await control.query('BEGIN');
      // `table` es un literal de las pruebas, nunca un dato externo.
      await control.query(
        `SELECT 1 FROM ${control.escapeIdentifier(lock.table)} WHERE id = $1 FOR UPDATE`,
        [lock.id],
      );
      promises = fire();
      try {
        blocked = await this.waitBlocked(expectedBlocked);
      } catch (error) {
        barrierError = error;
      }
    } finally {
      await control.query('ROLLBACK').catch(() => undefined);
      control.release();
    }
    const results = await Promise.all(promises);
    if (barrierError) throw barrierError as Error;
    recordEvidence(label, {
      lockedTable: lock.table,
      blockedSessions: blocked.length,
      distinctPids: new Set(blocked.map((b) => b.pid)).size,
      apis: [...new Set(blocked.map((b) => b.application_name))],
      waitEvents: [...new Set(blocked.map((b) => b.wait_event))],
      statuses: results
        .map((r) => (r as { status?: number }).status)
        .filter((s) => s !== undefined)
        .sort(),
    });
    return { results, blocked };
  }
}

export const statuses = (results: { status: number }[]) =>
  results.map((r) => r.status).sort((a, b) => a - b);
