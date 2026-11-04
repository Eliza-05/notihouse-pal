import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AuditService } from '../../src/audit/audit.service.js';
import {
  type Api,
  appUrl,
  Harness,
  httpClient,
  ownerUrl,
  startApi,
  statuses,
  type User,
} from './support/harness.js';

const ADMIN = fileURLToPath(
  new URL('../../../database/admin/', import.meta.url),
);

class FlakyAudit extends AuditService {
  failing = new Set<string>();
  private guard(action: string) {
    if (this.failing.has(action)) throw new Error('auditoría caída');
  }
  override async recordUserAction(
    ...args: Parameters<AuditService['recordUserAction']>
  ) {
    this.guard(args[1].action);
    return super.recordUserAction(...args);
  }
  override async recordAutomatedAction(
    ...args: Parameters<AuditService['recordAutomatedAction']>
  ) {
    this.guard(args[1].action);
    return super.recordAutomatedAction(...args);
  }
}

describe('Seguridad, atomicidad y rol restringido en PostgreSQL real', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(() => h.close());
  beforeEach(() => h.drainQueue());

  describe('Escenario M — aislamiento bajo concurrencia', () => {
    it('operaciones válidas y ajenas intercaladas: los permisos no dependen del orden', async () => {
      const [alice, bob] = [await h.newUser('alice'), await h.newUser('bob')];
      const world = async (u: User) => {
        const obligation = await h.obligation(u);
        const occurrence = await h.occurrence(u, obligation);
        const rental = await h.rental(u);
        const charge = await h.charge(u, rental);
        const review = await h.pendingReview(u);
        await h.drainQueue();
        const approved = await h.approvedProposal(u, '2099-05-15');
        await h.drainQueue();
        return { obligation, occurrence, rental, charge, review, approved };
      };
      const a = await world(alice);
      const b = await world(bob);

      const attacks = (actor: User, v: Awaited<ReturnType<typeof world>>) => [
        actor.a.get(`/obligations/${v.obligation}`),
        actor.b.patch(`/obligations/${v.obligation}`, { concept: 'hackeado' }),
        actor.a.post(
          `/obligations/${v.obligation}/occurrences/${v.occurrence}/confirm`,
          { result: 'paid' },
        ),
        actor.b.post(`/rentals/${v.rental}/charges/${v.charge}/confirm`, {
          evidence: 'ajena',
        }),
        actor.a.get(`/rentals/${v.rental}`),
        actor.b.post(`/hitl-requests/${v.review.reviewId}/decision`, {
          decision: 'approved',
        }),
        actor.a.get(`/hitl-requests/${v.review.reviewId}`),
        actor.b.post(
          `/cases/${v.approved.caseId}/proposals/${v.approved.proposalId}/apply`,
        ),
        actor.a.get(`/cases/${v.review.caseId}`),
      ];
      // Cada ronda mezcla lecturas legítimas y ataques cruzados en ambos pools.
      for (let round = 0; round < 3; round++) {
        const results = await Promise.all([
          ...attacks(alice, b),
          alice.a.get(`/obligations/${a.obligation}`),
          ...attacks(bob, a),
          bob.b.get(`/obligations/${b.obligation}`),
        ]);
        // Nueve ataques por actor, seguidos de su lectura legítima.
        const legit = [results[9]!, results[results.length - 1]!];
        const denied = results.filter((r) => !legit.includes(r));
        expect(statuses(legit)).toEqual([200, 200]);
        expect(new Set(denied.map((r) => r.status))).toEqual(new Set([404]));
      }
      // Los datos de cada propietario permanecen intactos.
      for (const v of [a, b]) {
        const [occ] = await h.sql(
          `SELECT status FROM obligation_occurrences WHERE id = $1`,
          [v.occurrence],
        );
        expect(occ!.status).toBe('pending');
        const [charge] = await h.sql(
          `SELECT status FROM rent_charges WHERE id = $1`,
          [v.charge],
        );
        expect(charge!.status).toBe('expected');
        const [review] = await h.sql(
          `SELECT status FROM hitl_requests WHERE id = $1`,
          [v.review.reviewId],
        );
        expect(review!.status).toBe('pending');
        expect(
          await h.count(
            `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
            [v.approved.proposalId],
          ),
        ).toBe(0);
      }
    });

    it('listados en paralelo: ningún registro cruzado por conexiones reutilizadas', async () => {
      const users = await Promise.all(
        Array.from({ length: 6 }, (_, i) => h.newUser(`u${i}`)),
      );
      const owned = new Map<string, string>();
      for (const user of users) {
        owned.set(await h.obligation(user), user.profileId);
      }
      const reads = await Promise.all(
        Array.from({ length: 40 }, (_, i) => {
          const user = users[i % users.length]!;
          return (i % 2 ? user.a : user.b)
            .get('/obligations')
            .then((res) => ({ user, res }));
        }),
      );
      for (const { user, res } of reads) {
        expect(res.status).toBe(200);
        for (const item of res.body.items as { id: string }[]) {
          expect(owned.get(item.id)).toBe(user.profileId);
        }
        expect(res.body.items).toHaveLength(1);
      }
    });

    it('token de servicio y JWT de usuario no son intercambiables', async () => {
      const user = await h.newUser();
      const results = await Promise.all([
        h.apiA.service.get('/obligations'),
        h.apiB.service.get('/dashboard/summary'),
        user.a.post('/internal/workflow-jobs/claim', { workerId: 'falso' }),
        user.b.post('/internal/alerts/evaluate', { workerId: 'falso' }),
        httpClient(h.apiA.baseUrl).get('/obligations'),
        httpClient(h.apiA.baseUrl, 'Bearer basura').post(
          '/internal/workflow-jobs/claim',
          { workerId: 'falso' },
        ),
      ]);
      expect(new Set(statuses(results))).toEqual(new Set([401]));
    });
  });

  describe('Atomicidad: un fallo de auditoría revierte la operación', () => {
    let api: Api;
    let audit: FlakyAudit;
    let user: User;
    let client: ReturnType<typeof httpClient>;
    let service: Api['service'];

    beforeAll(async () => {
      audit = new FlakyAudit();
      api = await startApi('atomic', (b) =>
        b.overrideProvider(AuditService).useValue(audit),
      );
      service = api.service;
      user = await h.newUser();
      client = httpClient(api.baseUrl, `Bearer ${user.token}`);
    });
    afterAll(() => api.close());
    afterEach(() => audit.failing.clear());

    const failing = async <T>(action: string, run: () => Promise<T>) => {
      audit.failing.add(action);
      try {
        return await run();
      } finally {
        audit.failing.delete(action);
      }
    };

    it.each(['case.create', 'workflow_job.create'])(
      'crear caso con fallo en %s no deja caso ni trabajo; el reintento funciona',
      async (action) => {
        const before = await h.count(
          `SELECT count(*) AS n FROM cases WHERE owner_id = $1`,
          [user.profileId],
        );
        const body = {
          type: 'household_obligation',
          requestId: crypto.randomUUID(),
        };
        const res = await failing(action, () => client.post('/cases', body));
        expect(res.status).toBe(500);
        expect(
          await h.count(`SELECT count(*) AS n FROM cases WHERE owner_id = $1`, [
            user.profileId,
          ]),
        ).toBe(before);
        expect(
          await h.count(
            `SELECT count(*) AS n FROM workflow_jobs WHERE idempotency_key = $1`,
            [`case-request:${user.profileId}:${body.requestId}`],
          ),
        ).toBe(0);
        expect((await client.post('/cases', body)).status).toBe(201);
      },
    );

    it('confirmar período, confirmar cobro y aplicar propuesta revierten', async () => {
      const obligation = await h.obligation(user);
      const occurrence = await h.occurrence(user, obligation);
      const occPath = `/obligations/${obligation}/occurrences/${occurrence}/confirm`;
      const res1 = await failing('obligation_occurrence.confirm', () =>
        client.post(occPath, { result: 'paid' }),
      );
      expect(res1.status).toBe(500);
      const [occ] = await h.sql(
        `SELECT status, confirmed_at FROM obligation_occurrences WHERE id = $1`,
        [occurrence],
      );
      expect(occ).toEqual({ status: 'pending', confirmed_at: null });

      const rental = await h.rental(user);
      const charge = await h.charge(user, rental);
      const res2 = await failing('rent_charge.confirm', () =>
        client.post(`/rentals/${rental}/charges/${charge}/confirm`, {
          evidence: 'x',
        }),
      );
      expect(res2.status).toBe(500);
      const [row] = await h.sql(
        `SELECT status, confirmation_evidence FROM rent_charges WHERE id = $1`,
        [charge],
      );
      expect(row).toEqual({ status: 'expected', confirmation_evidence: null });

      const r = await h.approvedProposal(user);
      const applyPath = `/cases/${r.caseId}/proposals/${r.proposalId}/apply`;
      for (const action of [
        'case_proposal.apply',
        'obligation_occurrence.create',
      ]) {
        const res = await failing(action, () => client.post(applyPath));
        expect(res.status).toBe(500);
        expect(
          await h.count(
            `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
            [r.proposalId],
          ),
        ).toBe(0);
        expect(
          await h.count(
            `SELECT count(*) AS n FROM obligation_occurrences WHERE obligation_id = $1`,
            [r.obligationId],
          ),
        ).toBe(0);
      }
      // Recuperado el fallo, se aplica exactamente una vez.
      expect((await client.post(applyPath)).status).toBe(201);
    });

    it('decidir HITL revierte decisión, propuesta y trabajo', async () => {
      const r = await h.pendingReview(user);
      const path = `/hitl-requests/${r.reviewId}/decision`;
      const res = await failing('case_proposal.accept', () =>
        client.post(path, { decision: 'approved' }),
      );
      expect(res.status).toBe(500);
      const [row] = await h.sql(
        `SELECT status, decision FROM hitl_requests WHERE id = $1`,
        [r.reviewId],
      );
      expect(row).toEqual({ status: 'pending', decision: null });
      const [proposal] = await h.sql(
        `SELECT review_status FROM case_proposals WHERE id = $1`,
        [r.proposalId],
      );
      expect(proposal!.review_status).toBe('pending_review');
      expect(
        await h.count(
          `SELECT count(*) AS n FROM workflow_jobs WHERE idempotency_key = $1`,
          [`hitl-decision:${r.reviewId}`],
        ),
      ).toBe(0);
    });

    it('la evaluación de alertas revierte la alerta si falla su evento', async () => {
      const obligation = await h.obligation(user);
      const today = new Date().toISOString().slice(0, 10);
      const occurrence = await h.occurrence(
        user,
        obligation,
        '2099-12-31',
        '2099-12-01',
      );
      await h.sql(
        `UPDATE obligation_occurrences SET period_start = $2, period_end = $2, due_date = $2 WHERE id = $1`,
        [occurrence, today],
      );
      const res = await failing('alert.create', () =>
        service.post('/internal/alerts/evaluate', {
          workerId: 'atomic',
          batchSize: 50,
        }),
      );
      expect(res.status).toBe(500);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM alerts WHERE occurrence_id = $1`,
          [occurrence],
        ),
      ).toBe(0);
      const retry = await service.post('/internal/alerts/evaluate', {
        workerId: 'atomic',
        batchSize: 50,
      });
      expect(retry.status).toBe(200);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM alerts WHERE occurrence_id = $1 AND state = 'active'`,
          [occurrence],
        ),
      ).toBe(1);
    });

    it('claim, complete y fail revierten si falla su evento', async () => {
      const c = await h.newCase(user);
      const lost = await failing('workflow_job.claim', () =>
        service.post('/internal/workflow-jobs/claim', { workerId: 'w' }),
      );
      expect(lost.status).toBe(500);
      const [row] = await h.sql(
        `SELECT status, attempts FROM workflow_jobs WHERE case_id = $1`,
        [c.id],
      );
      expect(row).toEqual({ status: 'pending', attempts: 0 });

      const job = await h.claimOf(c.id);
      const completion = await failing('workflow_job.complete', () =>
        service.post(`/internal/workflow-jobs/${job.id}/complete`, {
          claimToken: job.claimToken,
          result: { a: 1 },
        }),
      );
      expect(completion.status).toBe(500);
      expect((await h.job(job.id)).status).toBe('claimed');

      const failure = await failing('workflow_job.fail', () =>
        service.post(`/internal/workflow-jobs/${job.id}/fail`, {
          claimToken: job.claimToken,
          error: 'x',
        }),
      );
      expect(failure.status).toBe(500);
      expect((await h.job(job.id)).status).toBe('claimed');
    });
  });

  describe('Rol restringido notihouse_app', () => {
    let app: pg.Client;
    beforeAll(async () => {
      app = new pg.Client({ connectionString: appUrl() });
      await app.connect();
    });
    afterAll(() => app.end());

    it('la API de la suite corre como notihouse_app, sin privilegios elevados', async () => {
      const sessions = await h.sql(
        `SELECT DISTINCT usename FROM pg_stat_activity WHERE application_name LIKE 'notihouse-pal-api%'`,
      );
      expect(sessions.map((s) => s.usename)).toEqual(['notihouse_app']);
      const { rows } = await app.query(
        `SELECT current_user AS u, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
           FROM pg_roles WHERE rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        u: 'notihouse_app',
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolreplication: false,
      });
    });

    it('la matriz de privilegios preparada se cumple en PostgreSQL real', async () => {
      const client = new pg.Client({ connectionString: ownerUrl() });
      await client.connect();
      try {
        const { rows } = await client.query<{
          ok: boolean;
          table_name: string;
        }>(readFileSync(`${ADMIN}03-verify-app-privileges.sql`, 'utf8'));
        expect(rows).toHaveLength(18);
        expect(rows.filter((r) => !r.ok)).toEqual([]);
      } finally {
        await client.end();
      }
    });

    it.each([
      ['crear tabla', `CREATE TABLE public.intruso (id int)`],
      ['alterar tabla', `ALTER TABLE cases ADD COLUMN intruso int`],
      ['eliminar tabla', `DROP TABLE audit_events`],
      ['modificar auditoría', `UPDATE audit_events SET action = 'x'`],
      ['borrar auditoría', `DELETE FROM audit_events`],
      ['truncar auditoría', `TRUNCATE audit_events`],
      ['desactivar trigger', `ALTER TABLE audit_events DISABLE TRIGGER ALL`],
      ['borrar casos', `DELETE FROM cases`],
      ['borrar períodos', `DELETE FROM obligation_occurrences`],
      ['cambiar perfiles', `UPDATE profiles SET display_name = 'x'`],
      [
        'crear cuentas',
        `INSERT INTO auth_accounts (profile_id, email, password_hash) VALUES (gen_random_uuid(), 'x@x', '$argon2id$x')`,
      ],
      ['cambiar contraseñas', `UPDATE auth_accounts SET password_hash = 'x'`],
      ['leer migraciones', `SELECT * FROM drizzle.__drizzle_migrations`],
      ['crear rol', `CREATE ROLE intruso`],
      ['otorgarse privilegios', `GRANT notihouse_conc_owner TO notihouse_app`],
      ['crear base', `CREATE DATABASE intrusa`],
      [
        'cambiar ruta de datos del documento',
        `UPDATE documents SET storage_key = 'x'`,
      ],
      ['borrar aplicaciones', `DELETE FROM proposal_applications`],
    ])('prohibido: %s', async (_n, statement) => {
      await expect(app.query(statement)).rejects.toMatchObject({
        code: expect.stringMatching(/^(42501|25006|42P04)$/),
      });
    });

    it('las migraciones exigen otro rol: no puede escribir en el esquema', async () => {
      const { rows } = await app.query(
        `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS create_public,
                has_schema_privilege(current_user, 'drizzle', 'USAGE') AS use_drizzle`,
      );
      expect(rows[0]).toEqual({ create_public: false, use_drizzle: false });
    });

    it('login real con el rol restringido y operaciones de negocio', async () => {
      const user = await h.newUser('login', true);
      const anonymous = httpClient(h.apiA.baseUrl);
      const wrong = await anonymous.post('/auth/login', {
        email: user.email,
        password: 'incorrecta-incorrecta',
      });
      expect(wrong.status).toBe(401);
      const ok = await anonymous.post('/auth/login', {
        email: user.email,
        password: user.password,
      });
      expect(ok.status).toBe(200);
      const session = httpClient(
        h.apiB.baseUrl,
        `Bearer ${ok.body.accessToken}`,
      );
      expect((await session.get('/auth/me')).status).toBe(200);
      expect((await session.get('/dashboard/summary')).status).toBe(200);
    });
  });
});
