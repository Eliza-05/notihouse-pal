import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { offsetOf } from '../common/pagination.js';
import { DRIZZLE, type Database } from '../database/database.constants.js';
import {
  DueDateEvaluationService,
  type ReferenceTime,
} from '../due-dates/due-date-evaluation.service.js';
import {
  ATTENTION_PRIORITIES as P,
  type DueItemKind,
} from '../due-dates/due-date.rules.js';
import { resourcePath } from '../due-dates/resource-links.js';
import type {
  AttentionCondition,
  AttentionItemDto,
  AttentionPageDto,
  AttentionQueryDto,
  SuggestedAction,
} from './dto/attention.dto.js';

interface AttentionRow extends Record<string, unknown> {
  kind: DueItemKind;
  id: string;
  parent_id: string;
  status: string;
  relevant_date: string;
  due_at: Date | string | null;
  days_until: number;
  label: string | null;
  detail: string | null;
  amount: string | null;
  currency: string | null;
  alert_id: string | null;
  alert_read: boolean | null;
  condition: AttentionCondition;
  priority: number;
}

const DECISION_LABELS: Record<string, string> = {
  data_confirmation: 'confirmación de datos',
  conflict_resolution: 'resolución de conflicto',
  reminder_approval: 'aprobación de recordatorio',
  contract_review: 'revisión de contrato',
  other: 'otra decisión',
};

/**
 * Bandeja unificada de atención del usuario autenticado. Una sola consulta
 * SQL une las cuatro fuentes (cada rama filtrada por propietario en
 * PostgreSQL), clasifica cada elemento con las mismas reglas del motor de
 * vencimientos y pagina sobre el conjunto unificado con un orden total
 * estable: prioridad, fecha, hora límite, tipo e id. Solo lectura.
 */
@Injectable()
export class AttentionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly dueDates: DueDateEvaluationService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: AttentionQueryDto,
  ): Promise<AttentionPageDto> {
    const ref = this.dueDates.reference();
    const ranked = this.rankedItems(user.profileId, ref);
    const kind = query.kind ? sql`WHERE kind = ${query.kind}` : sql``;

    const [page, total] = await Promise.all([
      this.db.execute<AttentionRow>(sql`
        WITH ${ranked}
        SELECT * FROM ranked ${kind}
        ORDER BY priority, relevant_date, due_at NULLS FIRST, kind, id
        LIMIT ${query.pageSize} OFFSET ${offsetOf(query)}`),
      this.db.execute<{ n: number }>(sql`
        WITH ${ranked}
        SELECT count(*)::int AS n FROM ranked ${kind}`),
    ]);
    return {
      referenceDate: ref.today,
      items: page.rows.map((row) => this.toItem(row)),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(total.rows[0]!.n),
    };
  }

  /**
   * CTE `items` (fuentes), `classified` (condición) y `ranked` (prioridad).
   * Mismas reglas que `due-date.rules.ts`; la equivalencia está cubierta por
   * pruebas. Ningún identificador SQL proviene del cliente.
   */
  private rankedItems(ownerId: string, { now, today }: ReferenceTime): SQL {
    const r = this.dueDates.rules;
    const nowTs = sql`${now.toISOString()}::timestamptz`;
    const day = sql`${today}::date`;
    return sql`items AS (
      SELECT 'obligation_occurrence'::text AS kind, o.id, o.obligation_id AS parent_id,
             o.status::text AS status, o.due_date::text AS relevant_date,
             NULL::timestamptz AS due_at, (o.due_date - ${day}) AS days_until,
             ob.concept AS label, ob.provider_name AS detail,
             o.amount::text AS amount, o.currency::text AS currency,
             a.id AS alert_id, (a.read_at IS NOT NULL) AS alert_read
        FROM obligation_occurrences o
        JOIN obligations ob ON ob.id = o.obligation_id AND ob.owner_id = o.owner_id
        LEFT JOIN alerts a ON a.occurrence_id = o.id AND a.owner_id = o.owner_id
             AND a.state = 'active' AND a.relevant_date = o.due_date
       WHERE o.owner_id = ${ownerId}
         AND o.status IN ('pending', 'overdue')
         AND o.due_date <= ${day} + greatest(${r.obligationDays}::int, ob.reminder_days_before)
      UNION ALL
      SELECT 'rent_charge', c.id, c.rental_id, c.status::text, c.due_date::text,
             NULL::timestamptz, (c.due_date - ${day}),
             p.name, NULL::text, c.expected_amount::text, c.currency::text,
             a.id, (a.read_at IS NOT NULL)
        FROM rent_charges c
        JOIN rentals re ON re.id = c.rental_id AND re.owner_id = c.owner_id
        JOIN properties p ON p.id = re.property_id AND p.owner_id = c.owner_id
        LEFT JOIN alerts a ON a.rent_charge_id = c.id AND a.owner_id = c.owner_id
             AND a.state = 'active' AND a.relevant_date = c.due_date
       WHERE c.owner_id = ${ownerId}
         AND c.status IN ('expected', 'pending', 'overdue')
         AND c.due_date <= ${day} + ${r.rentChargeDays}::int
      UNION ALL
      SELECT 'contract', k.id, k.property_id, k.status::text, k.ends_on::text,
             NULL::timestamptz, (k.ends_on - ${day}),
             p.name, NULL::text, NULL::text, NULL::text,
             a.id, (a.read_at IS NOT NULL)
        FROM contracts k
        JOIN properties p ON p.id = k.property_id AND p.owner_id = k.owner_id
        LEFT JOIN alerts a ON a.contract_id = k.id AND a.owner_id = k.owner_id
             AND a.state = 'active' AND a.relevant_date = k.ends_on
       WHERE k.owner_id = ${ownerId}
         AND k.status = 'active'
         AND k.ends_on <= ${day} + greatest(${r.contractDays}::int, coalesce(k.notice_period_days, 0))
      UNION ALL
      SELECT 'hitl_request', h.id, h.case_id, h.status::text,
             (h.due_at AT TIME ZONE ${r.timeZone})::date::text,
             h.due_at, ((h.due_at AT TIME ZONE ${r.timeZone})::date - ${day}),
             h.decision_type::text, cs.type::text, NULL::text, NULL::text,
             a.id, (a.read_at IS NOT NULL)
        FROM hitl_requests h
        JOIN cases cs ON cs.id = h.case_id AND cs.owner_id = h.owner_id
        LEFT JOIN alerts a ON a.hitl_request_id = h.id AND a.owner_id = h.owner_id
             AND a.state = 'active'
       WHERE h.owner_id = ${ownerId}
         AND h.assigned_to = ${ownerId}
         AND h.status = 'pending'
    ),
    classified AS (
      SELECT items.*,
             CASE
               WHEN kind = 'hitl_request' THEN
                 CASE
                   WHEN due_at <= ${nowTs} THEN 'overdue'
                   WHEN due_at <= ${nowTs} + make_interval(hours => ${r.hitlSoonHours}::int) THEN 'due_soon'
                   ELSE 'pending'
                 END
               WHEN days_until < 0 THEN 'overdue'
               WHEN days_until = 0 THEN 'due_today'
               ELSE 'upcoming'
             END AS condition
        FROM items
    ),
    ranked AS (
      SELECT classified.*,
             CASE
               WHEN kind = 'hitl_request' AND condition IN ('overdue', 'due_soon') THEN ${P.hitl_due_soon}::int
               WHEN kind = 'hitl_request' THEN ${P.hitl_pending}::int
               WHEN condition = 'overdue' THEN ${P.overdue}::int
               WHEN condition = 'due_today' THEN ${P.due_today}::int
               ELSE ${P.upcoming}::int
             END AS priority
        FROM classified
    )`;
  }

  private toItem(row: AttentionRow): AttentionItemDto {
    const daysUntil = Number(row.days_until);
    return {
      kind: row.kind,
      id: row.id,
      title: this.title(row),
      description: this.description(row.kind, row.condition, daysUntil),
      relevantDate: row.relevant_date,
      dueAt: row.due_at === null ? null : new Date(row.due_at),
      status: row.status,
      condition: row.condition,
      priority: Number(row.priority),
      daysUntil,
      amount: row.amount,
      currency: row.currency,
      suggestedAction: this.action(row.kind, row.condition),
      resource: {
        type: row.kind,
        id: row.id,
        path: resourcePath(row.kind, row.id, row.parent_id),
      },
      alert: row.alert_id
        ? { id: row.alert_id, read: row.alert_read === true }
        : null,
    };
  }

  private title(row: AttentionRow): string {
    switch (row.kind) {
      case 'obligation_occurrence':
        return `${row.label} — ${row.detail}`;
      case 'rent_charge':
        return `Cobro de arriendo: ${row.label}`;
      case 'contract':
        return `Contrato: ${row.label}`;
      case 'hitl_request':
        return `Revisión: ${DECISION_LABELS[row.label ?? ''] ?? 'decisión'}`;
    }
  }

  private description(
    kind: DueItemKind,
    condition: AttentionCondition,
    daysUntil: number,
  ): string {
    if (kind === 'hitl_request') {
      if (condition === 'overdue') {
        return 'El plazo terminó sin decisión; no se aplicará nada';
      }
      return condition === 'due_soon'
        ? 'El plazo de decisión está por terminar'
        : 'Pendiente de tu decisión';
    }
    const verb = kind === 'contract' ? 'Finaliza' : 'Vence';
    const past = kind === 'contract' ? 'Finalizó' : 'Venció';
    const days = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`;
    if (condition === 'overdue') return `${past} hace ${days(-daysUntil)}`;
    if (condition === 'due_today') return `${verb} hoy`;
    return `${verb} en ${days(daysUntil)}`;
  }

  private action(
    kind: DueItemKind,
    condition: AttentionCondition,
  ): SuggestedAction {
    switch (kind) {
      case 'obligation_occurrence':
        return 'confirm_payment';
      case 'rent_charge':
        return 'confirm_receipt';
      case 'contract':
        return 'review_contract';
      case 'hitl_request':
        return condition === 'overdue' ? 'view_review' : 'decide_review';
    }
  }
}
