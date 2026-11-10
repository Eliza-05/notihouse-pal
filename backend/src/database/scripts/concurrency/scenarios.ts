/**
 * Escenarios de concurrencia de la Fase 4.2F.2 (docs/testing/neon-concurrency-plan.md).
 *
 * Cada escenario crea SUS PROPIOS datos sintéticos (marcados con `runId`) a
 * través de la API, lanza solicitudes simultáneas y verifica el resultado por
 * la API y con consultas de solo lectura. Nunca toca registros existentes.
 * Contra una API real con pool de conexiones, las solicitudes simultáneas
 * usan conexiones PostgreSQL distintas (contención real). En las pruebas
 * automáticas se ejecutan sobre PGlite (una conexión): eso valida la lógica
 * de los escenarios, NO la contención.
 */

import { randomUUID } from 'node:crypto';

export interface HttpResult {
  status: number;
  // Respuesta JSON de la API (forma variable según la ruta).
  body: Record<string, unknown> & { [key: string]: unknown };
}

export interface HttpActor {
  get(path: string): Promise<HttpResult>;
  post(path: string, body?: object): Promise<HttpResult>;
}

export interface ScenarioContext {
  runId: string;
  user: HttpActor;
  service: HttpActor;
  /** Consulta de SOLO LECTURA para verificar efectos (conteos de auditoría…). */
  readOnlyCount(query: string, params: unknown[]): Promise<number>;
  /** Espera hasta que venza un arrendamiento de `seconds` (real: dormir). */
  waitForLeaseExpiry(jobId: string, seconds: number): Promise<void>;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  details: string[];
}

type Scenario = (ctx: ScenarioContext) => Promise<string[]>;

class ScenarioFailure extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

const statuses = (results: HttpResult[]) =>
  results.map((r) => r.status).sort((a, b) => a - b);

const id = (r: HttpResult) => r.body.id as string;

async function expectStatus(
  promise: Promise<HttpResult>,
  status: number,
  what: string,
): Promise<HttpResult> {
  const result = await promise;
  check(
    result.status === status,
    `${what}: se esperaba ${status} y llegó ${result.status}`,
  );
  return result;
}

const auditCount = (ctx: ScenarioContext, action: string, resourceId: string) =>
  ctx.readOnlyCount(
    `SELECT count(*) AS n FROM audit_events WHERE action = $1 AND metadata->>'resourceId' = $2`,
    [action, resourceId],
  );

/** Obligación sintética del escenario. */
async function syntheticObligation(ctx: ScenarioContext, label: string) {
  return id(
    await expectStatus(
      ctx.user.post('/obligations', {
        providerName: `CONC ${ctx.runId}`,
        concept: `${label} ${ctx.runId}`,
        category: 'other',
        expectedAmount: '1000.00',
      }),
      201,
      'crear obligación sintética',
    ),
  );
}

/** Caso nuevo con su trabajo reclamado por este escenario. */
async function claimedCase(ctx: ScenarioContext, obligationId: string) {
  const c = await expectStatus(
    ctx.user.post('/cases', {
      type: 'household_obligation',
      obligationId,
    }),
    201,
    'crear caso',
  );
  const job = await claimJobOf(ctx, id(c), 'worker-a');
  return { caseId: id(c), job };
}

async function claimJobOf(
  ctx: ScenarioContext,
  caseId: string,
  workerId: string,
  leaseSeconds?: number,
) {
  const res = await expectStatus(
    ctx.service.post('/internal/workflow-jobs/claim', {
      workerId,
      limit: 10,
      jobTypes: ['case.household_obligation'],
      ...(leaseSeconds ? { leaseSeconds } : {}),
    }),
    200,
    'reclamar trabajo',
  );
  const jobs = res.body.jobs as {
    id: string;
    claimToken: string;
    case: { id: string };
  }[];
  const mine = jobs.find((j) => j.case.id === caseId);
  check(mine, `el trabajo del caso ${caseId} no apareció en la reclamación`);
  return mine;
}

/** 1. Clave de idempotencia de casos: N solicitudes simultáneas → un caso. */
const duplicateCaseRequest: Scenario = async (ctx) => {
  // Clave de idempotencia nueva por ejecución (UUID, como exige la API).
  const requestId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      ctx.user.post('/cases', { type: 'household_obligation', requestId }),
    ),
  );
  check(
    statuses(results).join() === '200,200,200,200,200,201',
    `estados ${statuses(results).join()}`,
  );
  check(new Set(results.map(id)).size === 1, 'se crearon casos distintos');
  return [`6 solicitudes → 1 caso (${id(results[0]!)})`];
};

/** 2. Dos workers reclaman a la vez: el trabajo pertenece a una sola reclamación. */
const claimRace: Scenario = async (ctx) => {
  const c = await expectStatus(
    ctx.user.post('/cases', { type: 'household_obligation' }),
    201,
    'crear caso',
  );
  const results = await Promise.all(
    ['worker-a', 'worker-b', 'worker-c'].map((workerId) =>
      ctx.service.post('/internal/workflow-jobs/claim', {
        workerId,
        limit: 10,
        jobTypes: ['case.household_obligation'],
      }),
    ),
  );
  const holders = results.flatMap((r) =>
    (
      r.body.jobs as { id: string; claimToken: string; case: { id: string } }[]
    ).filter((j) => j.case.id === id(c)),
  );
  check(
    holders.length === 1,
    `el trabajo quedó en ${holders.length} reclamaciones`,
  );
  await expectStatus(
    ctx.service.post(`/internal/workflow-jobs/${holders[0]!.id}/complete`, {
      claimToken: holders[0]!.claimToken,
    }),
    200,
    'completar',
  );
  return ['3 reclamaciones simultáneas → 1 titular'];
};

/** 3. Arrendamiento vencido: el worker antiguo ya no puede completar. */
const staleWorker: Scenario = async (ctx) => {
  const c = await expectStatus(
    ctx.user.post('/cases', { type: 'household_obligation' }),
    201,
    'crear caso',
  );
  const first = await claimJobOf(ctx, id(c), 'worker-old', 30);
  await ctx.waitForLeaseExpiry(first.id, 30);
  const second = await claimJobOf(ctx, id(c), 'worker-new');
  check(second.id === first.id, 'la nueva reclamación es de otro trabajo');
  const [old, current] = await Promise.all([
    ctx.service.post(`/internal/workflow-jobs/${first.id}/complete`, {
      claimToken: first.claimToken,
    }),
    ctx.service.post(`/internal/workflow-jobs/${second.id}/complete`, {
      claimToken: second.claimToken,
    }),
  ]);
  check(old.status === 409, `worker antiguo: ${old.status} (se esperaba 409)`);
  check(current.status === 200, `worker vigente: ${current.status}`);
  check(
    (await auditCount(ctx, 'workflow_job.complete', first.id)) === 1,
    'auditoría de complete distinta de 1',
  );
  return ['worker antiguo → 409; vigente → 200; 1 evento de auditoría'];
};

/** 4. Confirmaciones manuales simultáneas de un período. */
const occurrenceConfirmRace: Scenario = async (ctx) => {
  const obligation = await syntheticObligation(ctx, 'confirmaciones');
  const occurrence = id(
    await expectStatus(
      ctx.user.post(`/obligations/${obligation}/occurrences`, {
        periodStart: '2099-01-01',
        periodEnd: '2099-01-31',
        dueDate: '2099-01-15',
      }),
      201,
      'crear período',
    ),
  );
  const path = `/obligations/${obligation}/occurrences/${occurrence}/confirm`;
  const results = await Promise.all([
    ...Array.from({ length: 4 }, () =>
      ctx.user.post(path, { result: 'paid', reference: 'CONC' }),
    ),
    ctx.user.post(path, { result: 'attended' }),
  ]);
  const ok = results.filter((r) => r.status === 200);
  check(
    ok.every((r) => r.body.status === ok[0]!.body.status),
    'confirmaciones con resultados distintos aceptadas',
  );
  check(
    results.every((r) => r.status === 200 || r.status === 409),
    `estados inesperados ${statuses(results).join()}`,
  );
  check(
    (await auditCount(ctx, 'obligation_occurrence.confirm', occurrence)) === 1,
    'más de una confirmación auditada',
  );
  return [`5 confirmaciones → 1 registrada (${ok[0]!.body.status as string})`];
};

/** 5. Confirmaciones simultáneas de recepción de un cobro. */
const rentChargeConfirmRace: Scenario = async (ctx) => {
  const property = id(
    await expectStatus(
      ctx.user.post('/properties', { name: `CONC ${ctx.runId}` }),
      201,
      'crear inmueble',
    ),
  );
  const rental = id(
    await expectStatus(
      ctx.user.post('/rentals', {
        propertyId: property,
        expectedAmount: '1000.00',
        dueDay: 5,
        startsOn: '2099-01-01',
      }),
      201,
      'crear arriendo',
    ),
  );
  const charge = id(
    await expectStatus(
      ctx.user.post(`/rentals/${rental}/charges`, {
        periodStart: '2099-01-01',
        periodEnd: '2099-01-31',
        dueDate: '2099-01-05',
      }),
      201,
      'crear cobro',
    ),
  );
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      ctx.user.post(`/rentals/${rental}/charges/${charge}/confirm`, {
        evidence: `CONC ${ctx.runId}`,
      }),
    ),
  );
  check(
    results.every((r) => r.status === 200),
    `estados ${statuses(results).join()}`,
  );
  check(
    (await auditCount(ctx, 'rent_charge.confirm', charge)) === 1,
    'más de una recepción auditada',
  );
  return ['5 confirmaciones → 1 recepción registrada'];
};

/** 6. Decisiones HITL contradictorias simultáneas. */
const contradictoryHitl: Scenario = async (ctx) => {
  const obligation = await syntheticObligation(ctx, 'hitl');
  const { caseId, job } = await claimedCase(ctx, obligation);
  const review = id(
    await expectStatus(
      ctx.service.post(`/internal/cases/${caseId}/hitl-requests`, {
        jobId: job.id,
        claimToken: job.claimToken,
        decisionType: 'other',
        options: { summary: `CONC ${ctx.runId}` },
      }),
      201,
      'crear revisión',
    ),
  );
  const results = await Promise.all([
    ctx.user.post(`/hitl-requests/${review}/decision`, {
      decision: 'approved',
    }),
    ctx.user.post(`/hitl-requests/${review}/decision`, {
      decision: 'rejected',
    }),
  ]);
  check(
    statuses(results).join() === '200,409',
    `estados ${statuses(results).join()} (se esperaba 200,409)`,
  );
  const decided =
    (await auditCount(ctx, 'hitl_request.approve', review)) +
    (await auditCount(ctx, 'hitl_request.reject', review));
  check(decided === 1, `${decided} decisiones auditadas`);
  await ctx.service.post(`/internal/workflow-jobs/${job.id}/complete`, {
    claimToken: job.claimToken,
  });
  return ['aprobar y rechazar a la vez → una decisión, la otra 409'];
};

/** 7. Aplicaciones simultáneas de una propuesta aprobada. */
const applyRace: Scenario = async (ctx) => {
  const obligation = await syntheticObligation(ctx, 'aplicacion');
  const { caseId, job } = await claimedCase(ctx, obligation);
  const ref = { jobId: job.id, claimToken: job.claimToken };
  const proposal = id(
    await expectStatus(
      ctx.service.post(`/internal/cases/${caseId}/proposals`, {
        ...ref,
        source: 'llm',
        proposedData: {
          action: 'create_obligation_occurrence',
          data: {
            obligationId: obligation,
            periodStart: '2099-02-01',
            periodEnd: '2099-02-28',
            dueDate: '2099-02-15',
          },
        },
      }),
      201,
      'crear propuesta',
    ),
  );
  const review = id(
    await expectStatus(
      ctx.service.post(`/internal/cases/${caseId}/hitl-requests`, {
        ...ref,
        decisionType: 'data_confirmation',
        proposalId: proposal,
        options: { summary: `CONC ${ctx.runId}` },
      }),
      201,
      'crear revisión',
    ),
  );
  await expectStatus(
    ctx.user.post(`/hitl-requests/${review}/decision`, {
      decision: 'approved',
    }),
    200,
    'aprobar',
  );
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      ctx.user.post(`/cases/${caseId}/proposals/${proposal}/apply`),
    ),
  );
  check(
    statuses(results).join() === '200,200,200,200,201',
    `estados ${statuses(results).join()}`,
  );
  check(
    (await ctx.readOnlyCount(
      `SELECT count(*) AS n FROM proposal_applications WHERE proposal_id = $1`,
      [proposal],
    )) === 1,
    'más de una aplicación registrada',
  );
  await ctx.service.post(`/internal/workflow-jobs/${job.id}/complete`, {
    claimToken: job.claimToken,
  });
  return ['5 aplicaciones → 1 período pendiente'];
};

/** 8. Evaluaciones de alertas simultáneas: nunca dos alertas activas por recurso. */
const alertEvaluationRace: Scenario = async (ctx) => {
  const obligation = await syntheticObligation(ctx, 'alertas');
  const today = new Date().toISOString().slice(0, 10);
  const occurrence = id(
    await expectStatus(
      ctx.user.post(`/obligations/${obligation}/occurrences`, {
        periodStart: today,
        periodEnd: today,
        dueDate: today,
      }),
      201,
      'crear período',
    ),
  );
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      ctx.service.post('/internal/alerts/evaluate', {
        workerId: 'conc-scheduler',
        batchSize: 50,
      }),
    ),
  );
  check(
    results.every((r) => r.status === 200),
    `estados ${statuses(results).join()}`,
  );
  const active = await ctx.readOnlyCount(
    `SELECT count(*) AS n FROM alerts WHERE occurrence_id = $1 AND state = 'active'`,
    [occurrence],
  );
  check(active === 1, `${active} alertas activas para el período`);
  return ['3 evaluaciones simultáneas → 1 alerta activa'];
};

/** 9. `complete` duplicado: idéntico → 200; contradictorio → 409 sin cambios. */
const contradictoryComplete: Scenario = async (ctx) => {
  const c = await expectStatus(
    ctx.user.post('/cases', { type: 'household_obligation' }),
    201,
    'crear caso',
  );
  const job = await claimJobOf(ctx, id(c), 'worker-complete');
  const path = `/internal/workflow-jobs/${job.id}/complete`;
  const results = await Promise.all(
    [1, 2, 1, 2].map((n) =>
      ctx.service.post(path, {
        claimToken: job.claimToken,
        result: { n },
      }),
    ),
  );
  check(
    statuses(results).join() === '200,200,409,409',
    `estados ${statuses(results).join()}`,
  );
  check(
    (await auditCount(ctx, 'workflow_job.complete', job.id)) === 1,
    'más de un complete auditado',
  );
  return ['2×resultado A y 2×resultado B → un resultado; los contrarios 409'];
};

/** 10. Arriendos solapados simultáneos en un inmueble: entra uno solo. */
const rentalOverlapRace: Scenario = async (ctx) => {
  const property = id(
    await expectStatus(
      ctx.user.post('/properties', { name: `CONC-L ${ctx.runId}` }),
      201,
      'crear inmueble',
    ),
  );
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      ctx.user.post('/rentals', {
        propertyId: property,
        expectedAmount: '1000.00',
        dueDay: 5,
        startsOn: '2099-01-01',
        endsOn: '2099-12-31',
      }),
    ),
  );
  check(
    statuses(results).join() === '201,409,409,409',
    `estados ${statuses(results).join()}`,
  );
  return ['4 altas solapadas → 1 arriendo; 3 reciben 409'];
};

export const SCENARIOS: Record<string, Scenario> = {
  'duplicate-case-request': duplicateCaseRequest,
  'claim-race': claimRace,
  'stale-worker': staleWorker,
  'occurrence-confirm-race': occurrenceConfirmRace,
  'rent-charge-confirm-race': rentChargeConfirmRace,
  'contradictory-hitl': contradictoryHitl,
  'apply-race': applyRace,
  'alert-evaluation-race': alertEvaluationRace,
  'contradictory-complete': contradictoryComplete,
  'rental-overlap-race': rentalOverlapRace,
};

/** Ejecuta en orden; se detiene en el primer fallo (criterio de parada). */
export async function runScenarios(
  ctx: ScenarioContext,
  names: string[] = Object.keys(SCENARIOS),
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`Escenario desconocido: ${name}`);
    try {
      results.push({ name, passed: true, details: await scenario(ctx) });
    } catch (error) {
      results.push({
        name,
        passed: false,
        details: [(error as Error).message],
      });
      break;
    }
  }
  return results;
}
