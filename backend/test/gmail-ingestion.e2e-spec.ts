import type { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import request from 'supertest';
import { AuditService } from '../src/audit/audit.service.js';
import { ConfiguredMailboxes } from '../src/ingestion/gmail/configured-mailboxes.js';
import { GMAIL_MAILBOX_RESOLVER } from '../src/ingestion/gmail/gmail.contract.js';
import {
  FILE_STORAGE,
  StorageUnavailableError,
} from '../src/storage/file-storage.js';
import {
  createMigratedDatabase,
  createTestUser,
  type TestDatabase,
  type TestUser,
} from './support/pglite.js';
import {
  pdfWithJavaScript,
  samplePdf,
  truncatedPdf,
} from './support/sample-files.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const MAILBOX = 'facturas.demo@example.com';
const ROUTE = '/api/v1/internal/gmail/attachments';

/** Recepción de adjuntos de Gmail: buzón vinculado, validación, idempotencia y aislamiento. */
describe('Gmail attachments (e2e)', () => {
  let t: TestDatabase;
  let h: TestApp;
  let laura: TestUser;
  let andres: TestUser;
  let disabled: TestUser;
  const STORAGE = process.env.STORAGE_LOCAL_PATH!;
  const pw = () => randomBytes(12).toString('base64url');

  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => (await t.client.query<T>(query, params)).rows;

  const resolverFor = (links: string | undefined) =>
    new ConfiguredMailboxes(t.db as never, {
      get: () => links,
    } as unknown as ConfigService<never, true>);

  const counts = async () =>
    (
      await sql<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM documents) AS documents,
                (SELECT count(*)::int FROM cases) AS cases,
                (SELECT count(*)::int FROM workflow_jobs) AS jobs,
                (SELECT count(*)::int FROM obligations) AS obligations,
                (SELECT count(*)::int FROM case_proposals) AS proposals,
                (SELECT count(*)::int FROM hitl_requests) AS hitl`,
      )
    )[0]!;

  const storedFiles = async () => {
    try {
      const entries = await readdir(STORAGE, {
        recursive: true,
        withFileTypes: true,
      });
      return entries.filter((e) => e.isFile()).length;
    } catch {
      return 0;
    }
  };

  interface SendOptions {
    app?: TestApp;
    auth?: string;
    fields?: Record<string, string>;
    file?: Buffer | null;
    filename?: string;
    contentType?: string;
  }

  const newMessageId = () => randomBytes(8).toString('hex');

  const send = ({
    app = h,
    auth = `Bearer ${process.env.N8N_SERVICE_TOKEN}`,
    fields = {},
    file = samplePdf(`Factura ${randomUUID()}`),
    filename = 'factura.pdf',
    contentType = 'application/pdf',
  }: SendOptions = {}) => {
    const all = {
      mailbox: MAILBOX,
      messageId: newMessageId(),
      partId: '1',
      receivedAt: '2026-11-03T14:05:00Z',
      ...fields,
    };
    let req = request(app.app.getHttpServer())
      .post(ROUTE)
      .set('Authorization', auth);
    for (const [key, value] of Object.entries(all)) req = req.field(key, value);
    return file ? req.attach('file', file, { filename, contentType }) : req;
  };

  beforeAll(async () => {
    t = await createMigratedDatabase();
    [laura, andres, disabled] = await Promise.all(
      ['laura', 'andres', 'inactiva'].map((name) =>
        createTestUser(t.db, {
          email: `${name}@notihouse.test`,
          password: pw(),
          displayName: name,
        }),
      ),
    );
    await sql(
      `UPDATE auth_accounts SET is_active = false WHERE profile_id = $1`,
      [disabled.profileId],
    );
    const links = [
      `${MAILBOX}=${laura.profileId}`,
      `inactiva@example.com=${disabled.profileId}`,
      `fantasma@example.com=${randomUUID()}`,
    ].join(',');
    h = await createTestApp(t.db, (b) =>
      b.overrideProvider(GMAIL_MAILBOX_RESOLVER).useValue(resolverFor(links)),
    );
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
    await t.client.close();
  });

  describe('a linked mailbox with a valid PDF', () => {
    it('creates document, gmail case and document.process job for the linked owner only', async () => {
      const messageId = newMessageId();
      const before = await counts();
      const res = await send({ fields: { messageId, partId: '1.2' } }).expect(
        201,
      );
      expect(res.body).toMatchObject({
        source: 'gmail',
        documentType: 'invoice',
        mimeType: 'application/pdf',
        caseStatus: 'received',
        job: { type: 'document.process', status: 'pending' },
        duplicateContent: false,
      });
      expect(res.headers['x-correlation-id']).toBe(res.body.correlationId);
      const [doc] = await sql<Record<string, string>>(
        `SELECT d.owner_id, d.source, d.external_message_id, c.owner_id AS case_owner, c.source AS case_source
           FROM documents d JOIN cases c ON c.id = d.case_id WHERE d.id = $1`,
        [res.body.documentId],
      );
      expect(doc).toEqual({
        owner_id: laura.profileId,
        source: 'gmail',
        external_message_id: `gmail:${messageId}`,
        case_owner: laura.profileId,
        case_source: 'gmail',
      });
      // La IA y las obligaciones no intervienen: solo queda un trabajo en cola.
      const after = await counts();
      expect(after).toEqual({
        ...before,
        documents: before.documents! + 1,
        cases: before.cases! + 1,
        jobs: before.jobs! + 1,
      });
    });

    it('audits as the workflow, without the mailbox, sender or subject', async () => {
      const res = await send({
        fields: { workflowRunId: 'run-42' },
      }).expect(201);
      const events = await sql<Record<string, string | object>>(
        `SELECT actor_type, actor_id, action, result, metadata FROM audit_events WHERE correlation_id = $1 ORDER BY occurred_at, id`,
        [res.body.correlationId],
      );
      expect(events.map((e) => e.action).sort()).toEqual([
        'case.create',
        'document.receive',
        'workflow_job.create',
      ]);
      for (const e of events) {
        expect(e.actor_type).toBe('workflow');
        expect(e.actor_id).toBe('n8n:gmail-intake');
        expect(e.result).toBe('success');
        expect(JSON.stringify(e.metadata)).not.toContain('example.com');
      }
      const receive = events.find((e) => e.action === 'document.receive')!;
      expect(receive.metadata).toMatchObject({
        source: 'gmail',
        gmailPartId: '1',
        workflowRunId: 'run-42',
      });
    });

    it('shows the document to its owner and hides it from other accounts', async () => {
      const res = await send().expect(201);
      await h.as(laura).get(`/documents/${res.body.documentId}`).expect(200);
      await h.as(laura).get(`/cases/${res.body.caseId}`).expect(200);
      await h.as(andres).get(`/documents/${res.body.documentId}`).expect(404);
      await h.as(andres).get(`/cases/${res.body.caseId}`).expect(404);
    });

    it('can be claimed and read by the existing document worker', async () => {
      const res = await send().expect(201);
      // Reclama por lotes hasta llegar al trabajo de este caso.
      interface Claimed {
        id: string;
        claimToken: string;
        case: { id: string };
        payload: Record<string, unknown>;
      }
      let job: Claimed | undefined;
      while (!job) {
        const claimed = await h
          .asService()
          .post('/internal/workflow-jobs/claim', {
            workerId: 'worker-1',
            limit: 1,
            jobTypes: ['document.process'],
          })
          .expect(200);
        const batch = claimed.body.jobs as Claimed[];
        expect(batch.length).toBe(1);
        job = batch.find((j) => j.case.id === res.body.caseId);
      }
      expect(job.payload).toMatchObject({
        documentType: 'invoice',
        mimeType: 'application/pdf',
      });
      await request(h.app.getHttpServer())
        .get(`/api/v1/internal/documents/${res.body.documentId}/content`)
        .set('Authorization', `Bearer ${process.env.N8N_SERVICE_TOKEN}`)
        .set('X-Job-Id', job.id)
        .set('X-Claim-Token', job.claimToken)
        .expect(200);
    });
  });

  describe('idempotency', () => {
    it('repeating the same mailbox, message and part creates nothing new', async () => {
      const fields = { messageId: newMessageId(), partId: '2' };
      const file = samplePdf('misma factura repetida');
      const first = await send({ fields, file }).expect(201);
      const before = await counts();
      const files = await storedFiles();
      // Otro nombre de archivo y otra hora: la clave no depende de ellos.
      const again = await send({
        fields: { ...fields, receivedAt: '2026-11-04T00:00:00Z' },
        file,
        filename: 'renombrada.pdf',
      }).expect(200);
      expect(again.body.documentId).toBe(first.body.documentId);
      expect(again.body.caseId).toBe(first.body.caseId);
      expect(await counts()).toEqual(before);
      expect(await storedFiles()).toBe(files);
    });

    it('a concurrent repetition still produces a single document', async () => {
      const fields = { messageId: newMessageId() };
      const file = samplePdf('factura concurrente');
      const before = await counts();
      const results = await Promise.all([
        send({ fields, file }),
        send({ fields, file }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
      expect(results[0]!.body.documentId).toBe(results[1]!.body.documentId);
      expect((await counts()).documents).toBe(before.documents! + 1);
    });

    it('rejects the same message and part with different content (409)', async () => {
      const fields = { messageId: newMessageId() };
      await send({ fields }).expect(201);
      const before = await counts();
      await send({ fields }).expect(409);
      expect(await counts()).toEqual(before);
    });

    it('a new email with an identical file is a new case flagged as duplicate content', async () => {
      const file = samplePdf('archivo identico en dos correos');
      const first = await send({ file }).expect(201);
      const second = await send({ file }).expect(201);
      expect(second.body.caseId).not.toBe(first.body.caseId);
      expect(second.body.sha256).toBe(first.body.sha256);
      expect(second.body.duplicateContent).toBe(true);
    });

    it('two parts of one message are two documents', async () => {
      const messageId = newMessageId();
      const a = await send({ fields: { messageId, partId: '1' } }).expect(201);
      const b = await send({ fields: { messageId, partId: '2' } }).expect(201);
      expect(a.body.documentId).not.toBe(b.body.documentId);
    });

    it('a repetition after relinking the mailbox never moves data to the new owner', async () => {
      const fields = { messageId: newMessageId() };
      const file = samplePdf('factura antes de cambiar el vinculo');
      const first = await send({ fields, file }).expect(201);
      const relinked = await createTestApp(t.db, (b) =>
        b
          .overrideProvider(GMAIL_MAILBOX_RESOLVER)
          .useValue(resolverFor(`${MAILBOX}=${andres.profileId}`)),
      );
      try {
        const before = await counts();
        const res = await send({ app: relinked, fields, file });
        expect(res.status).toBe(409);
        expect(await counts()).toEqual(before);
        expect(JSON.stringify(res.body)).not.toContain(first.body.caseId);
      } finally {
        await relinked.app.close();
      }
    });
  });

  describe('mailbox link', () => {
    it.each([
      ['unlinked', 'otra@example.com'],
      ['linked to a disabled account', 'inactiva@example.com'],
      ['linked to a missing profile', 'fantasma@example.com'],
    ])('rejects a mailbox %s (403), storing nothing', async (_c, mailbox) => {
      const before = await counts();
      const files = await storedFiles();
      const res = await send({ fields: { mailbox } }).expect(403);
      expect(res.body.message).toMatch(/no está vinculado/);
      expect(await counts()).toEqual(before);
      expect(await storedFiles()).toBe(files);
    });

    it('rejects every mailbox with the default configuration (no links)', async () => {
      const app = await createTestApp(t.db);
      try {
        await send({ app }).expect(403);
      } finally {
        await app.app.close();
      }
    });

    it('matches the mailbox ignoring case, with the same deduplication key', async () => {
      const fields = { messageId: newMessageId() };
      const file = samplePdf('mayusculas en el buzon');
      await send({ fields, file }).expect(201);
      await send({
        fields: { ...fields, mailbox: MAILBOX.toUpperCase() },
        file,
      }).expect(200);
    });
  });

  describe('authorization', () => {
    it('rejects missing or wrong service tokens and user JWT, storing nothing', async () => {
      const before = await counts();
      const files = await storedFiles();
      await send({ auth: '' }).expect(401);
      await send({ auth: 'Bearer incorrecto' }).expect(401);
      await send({ auth: `Bearer ${h.tokenFor(laura)}` }).expect(401);
      expect(await counts()).toEqual(before);
      expect(await storedFiles()).toBe(files);
    });
  });

  describe('contract', () => {
    it.each([
      ['client ownerId', { ownerId: randomUUID() }],
      ['client caseId', { caseId: randomUUID() }],
      ['OAuth token', { accessToken: 'ya29.fake' }],
      ['bad message id', { messageId: '../x' }],
      ['bad part id', { partId: 'a/b' }],
      ['bad mailbox', { mailbox: 'not-an-email' }],
      ['bad date', { receivedAt: 'yesterday' }],
    ])('rejects %s (400)', async (_c, fields) => {
      const before = await counts();
      await send({ fields: fields as Record<string, string> }).expect(400);
      expect(await counts()).toEqual(before);
    });

    it('rejects a missing file (400)', async () => {
      await send({ file: null }).expect(400);
    });
  });

  describe('file validation', () => {
    it.each<[string, Buffer, string, string, number]>([
      ['non PDF type', samplePdf(), 'factura.pdf', 'text/html', 415],
      ['non PDF extension', samplePdf(), 'factura.exe', 'application/pdf', 415],
      [
        'misleading .pdf extension',
        Buffer.from('MZ este contenido no es un PDF'),
        'factura.pdf',
        'application/pdf',
        415,
      ],
      ['truncated PDF', truncatedPdf(), 'factura.pdf', 'application/pdf', 400],
      [
        'PDF with active content',
        pdfWithJavaScript(),
        'factura.pdf',
        'application/pdf',
        415,
      ],
      [
        'oversized PDF',
        Buffer.concat([samplePdf(), Buffer.alloc(70 * 1024, 0x20)]),
        'factura.pdf',
        'application/pdf',
        413,
      ],
    ])(
      'rejects %s, storing nothing',
      async (_c, file, filename, type, code) => {
        const before = await counts();
        const files = await storedFiles();
        await send({ file, filename, contentType: type }).expect(code);
        expect(await counts()).toEqual(before);
        expect(await storedFiles()).toBe(files);
      },
    );
  });

  describe('failures', () => {
    it('storage failure: 503, nothing created, failure audited as the workflow, and it can be retried', async () => {
      const failing = await createTestApp(t.db, (b) =>
        b
          .overrideProvider(GMAIL_MAILBOX_RESOLVER)
          .useValue(resolverFor(`${MAILBOX}=${laura.profileId}`))
          .overrideProvider(FILE_STORAGE)
          .useValue({
            put: () => Promise.reject(new StorageUnavailableError()),
            get: () => Promise.reject(new StorageUnavailableError()),
            stat: () => Promise.resolve(null),
            removeAfterFailedWrite: () => Promise.resolve(),
          }),
      );
      try {
        const fields = { messageId: newMessageId() };
        const file = samplePdf('reintento tras fallo de almacenamiento');
        const before = await counts();
        const res = await send({ app: failing, fields, file }).expect(503);
        expect(JSON.stringify(res.body)).not.toMatch(/storage\/|[A-Z]:\\/);
        expect(await counts()).toEqual(before);
        const [event] = await sql<Record<string, string>>(
          `SELECT actor_type, actor_id, result, owner_id FROM audit_events
            WHERE action = 'document.store_failed' ORDER BY occurred_at DESC LIMIT 1`,
        );
        expect(event).toEqual({
          actor_type: 'workflow',
          actor_id: 'n8n:gmail-intake',
          result: 'failure',
          owner_id: laura.profileId,
        });
        // El reintento con el mismo mensaje funciona cuando el servicio vuelve.
        await send({ fields, file }).expect(201);
      } finally {
        await failing.app.close();
      }
    });

    it('database failure: removes the stored object and creates nothing', async () => {
      const reject = () => Promise.reject(new Error('audit down'));
      const failing = await createTestApp(t.db, (b) =>
        b
          .overrideProvider(GMAIL_MAILBOX_RESOLVER)
          .useValue(resolverFor(`${MAILBOX}=${laura.profileId}`))
          .overrideProvider(AuditService)
          .useValue({
            recordUserAction: reject,
            recordAutomatedAction: reject,
          }),
      );
      try {
        const before = await counts();
        const files = await storedFiles();
        await send({ app: failing }).expect(500);
        expect(await counts()).toEqual(before);
        expect(await storedFiles()).toBe(files);
      } finally {
        await failing.app.close();
      }
    });
  });
});
