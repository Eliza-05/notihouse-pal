import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { effectivelyActive } from '../alerts/alert-sql.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { DRIZZLE, type Database } from '../database/database.constants.js';
import { monthBounds } from '../due-dates/calendar.js';
import { DueDateEvaluationService } from '../due-dates/due-date-evaluation.service.js';
import type {
  DashboardSummaryDto,
  MonthObligationAmountDto,
  MonthRentAmountDto,
  OpenAmountDto,
} from './dto/dashboard.dto.js';

type Counts = Record<string, number>;

const MONEY_NOTE =
  'Valores esperados y confirmaciones declaradas por el usuario. No son saldos bancarios ni pagos verificados.';

/**
 * Indicadores de la pantalla principal. Todo se agrega en PostgreSQL
 * (COUNT/SUM con filtro por propietario); ninguna fila se trae a memoria para
 * contarla. Los montos son `numeric` convertidos a texto: nunca `float`, y
 * siempre agrupados por moneda (no se suman monedas distintas). Solo lectura.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly dueDates: DueDateEvaluationService,
  ) {}

  async summary(user: AuthenticatedUser): Promise<DashboardSummaryDto> {
    const owner = user.profileId;
    const { now, today } = this.dueDates.reference();
    const r = this.dueDates.rules;
    const day = sql`${today}::date`;
    const month = monthBounds(today);
    const monthStart = sql`${month.start}::date`;
    const monthEnd = sql`${month.next}::date`;

    const [counts, obligationsOpen, rentOpen, obligationsMonth, rentMonth] =
      await Promise.all([
        this.db.execute<Counts>(sql`
          SELECT
            (SELECT count(*)::int FROM properties WHERE owner_id = ${owner}) AS properties_total,
            (SELECT count(*)::int FROM properties WHERE owner_id = ${owner} AND status = 'active') AS properties_active,
            (SELECT count(*)::int FROM obligations WHERE owner_id = ${owner} AND status = 'active') AS obligations_active,
            (SELECT count(*)::int FROM obligation_occurrences WHERE owner_id = ${owner}
               AND status IN ('pending', 'overdue') AND due_date >= ${day}) AS periods_pending,
            (SELECT count(*)::int FROM obligation_occurrences WHERE owner_id = ${owner}
               AND status IN ('pending', 'overdue') AND due_date < ${day}) AS periods_overdue,
            (SELECT count(*)::int FROM obligation_occurrences o
               JOIN obligations ob ON ob.id = o.obligation_id AND ob.owner_id = o.owner_id
              WHERE o.owner_id = ${owner} AND o.status IN ('pending', 'overdue')
                AND o.due_date >= ${day}
                AND o.due_date <= ${day} + greatest(${r.obligationDays}::int, ob.reminder_days_before)) AS periods_due_soon,
            (SELECT count(*)::int FROM obligation_occurrences WHERE owner_id = ${owner}
               AND status IN ('paid', 'attended')) AS periods_confirmed,
            (SELECT count(*)::int FROM rent_charges WHERE owner_id = ${owner}
               AND status IN ('expected', 'pending', 'overdue') AND due_date >= ${day}) AS charges_pending,
            (SELECT count(*)::int FROM rent_charges WHERE owner_id = ${owner}
               AND status IN ('expected', 'pending', 'overdue') AND due_date < ${day}) AS charges_overdue,
            (SELECT count(*)::int FROM rent_charges WHERE owner_id = ${owner}
               AND status IN ('expected', 'pending', 'overdue')
               AND due_date >= ${day} AND due_date <= ${day} + ${r.rentChargeDays}::int) AS charges_due_soon,
            (SELECT count(*)::int FROM rent_charges WHERE owner_id = ${owner} AND status = 'received') AS charges_received,
            (SELECT count(*)::int FROM contracts WHERE owner_id = ${owner} AND status = 'active') AS contracts_active,
            (SELECT count(*)::int FROM contracts WHERE owner_id = ${owner} AND status = 'active'
               AND ends_on >= ${day}
               AND ends_on <= ${day} + greatest(${r.contractDays}::int, coalesce(notice_period_days, 0))) AS contracts_ending_soon,
            (SELECT count(*)::int FROM contracts WHERE owner_id = ${owner} AND status = 'active'
               AND ends_on < ${day}) AS contracts_end_passed,
            (SELECT count(*)::int FROM hitl_requests WHERE owner_id = ${owner} AND assigned_to = ${owner}
               AND status = 'pending' AND due_at > ${now.toISOString()}::timestamptz) AS hitl_pending,
            (SELECT count(*)::int FROM alerts WHERE alerts.owner_id = ${owner} AND ${effectivelyActive}) AS alerts_active,
            (SELECT count(*)::int FROM alerts WHERE alerts.owner_id = ${owner} AND alerts.read_at IS NULL
               AND ${effectivelyActive}) AS alerts_unread,
            (SELECT count(*)::int FROM cases WHERE owner_id = ${owner}
               AND status NOT IN ('completed', 'failed', 'cancelled')) AS cases_open`),
        this.db.execute<OpenAmountRow>(sql`
          SELECT currency::text AS currency, round(coalesce(sum(amount), 0), 2)::text AS total,
                 count(*)::int AS count, (count(*) FILTER (WHERE amount IS NULL))::int AS without_amount
            FROM obligation_occurrences
           WHERE owner_id = ${owner} AND status IN ('pending', 'overdue')
           GROUP BY currency ORDER BY currency`),
        this.db.execute<OpenAmountRow>(sql`
          SELECT currency::text AS currency, round(sum(expected_amount), 2)::text AS total,
                 count(*)::int AS count, 0 AS without_amount
            FROM rent_charges
           WHERE owner_id = ${owner} AND status IN ('expected', 'pending', 'overdue')
           GROUP BY currency ORDER BY currency`),
        this.db.execute<MonthObligationAmountDto & Record<string, unknown>>(sql`
          SELECT currency::text AS currency,
                 round(coalesce(sum(amount) FILTER (WHERE status <> 'cancelled'), 0), 2)::text AS expected,
                 round(coalesce(sum(amount) FILTER (WHERE status IN ('paid', 'attended')), 0), 2)::text AS confirmed
            FROM obligation_occurrences
           WHERE owner_id = ${owner} AND due_date >= ${monthStart} AND due_date < ${monthEnd}
           GROUP BY currency ORDER BY currency`),
        this.db.execute<MonthRentAmountDto & Record<string, unknown>>(sql`
          SELECT currency::text AS currency,
                 round(coalesce(sum(expected_amount) FILTER (WHERE status <> 'cancelled'), 0), 2)::text AS expected,
                 round(coalesce(sum(expected_amount) FILTER (WHERE status = 'received'), 0), 2)::text AS received
            FROM rent_charges
           WHERE owner_id = ${owner} AND due_date >= ${monthStart} AND due_date < ${monthEnd}
           GROUP BY currency ORDER BY currency`),
      ]);

    const c = counts.rows[0]!;
    const n = (key: string) => Number(c[key]);
    return {
      referenceDate: today,
      timeZone: r.timeZone,
      properties: {
        total: n('properties_total'),
        active: n('properties_active'),
      },
      obligations: {
        active: n('obligations_active'),
        periodsPending: n('periods_pending'),
        periodsOverdue: n('periods_overdue'),
        periodsDueSoon: n('periods_due_soon'),
        periodsConfirmed: n('periods_confirmed'),
      },
      rentCharges: {
        pending: n('charges_pending'),
        overdue: n('charges_overdue'),
        dueSoon: n('charges_due_soon'),
        received: n('charges_received'),
      },
      contracts: {
        active: n('contracts_active'),
        endingSoon: n('contracts_ending_soon'),
        endPassed: n('contracts_end_passed'),
      },
      hitl: { pending: n('hitl_pending') },
      alerts: { active: n('alerts_active'), unread: n('alerts_unread') },
      cases: { open: n('cases_open') },
      money: {
        note: MONEY_NOTE,
        obligationsOpen: obligationsOpen.rows.map(toOpenAmount),
        rentOpen: rentOpen.rows.map(toOpenAmount),
        month: { start: month.start, end: month.next },
        obligationsThisMonth: obligationsMonth.rows.map((row) => ({
          currency: row.currency,
          expected: row.expected,
          confirmed: row.confirmed,
        })),
        rentThisMonth: rentMonth.rows.map((row) => ({
          currency: row.currency,
          expected: row.expected,
          received: row.received,
        })),
      },
    };
  }
}

interface OpenAmountRow extends Record<string, unknown> {
  currency: string;
  total: string;
  count: number;
  without_amount: number;
}

function toOpenAmount(row: OpenAmountRow): OpenAmountDto {
  return {
    currency: row.currency,
    total: row.total,
    count: Number(row.count),
    withoutAmount: Number(row.without_amount),
  };
}
