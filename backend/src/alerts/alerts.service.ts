import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { offsetOf, type Page } from '../common/pagination.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../database/database.constants.js';
import {
  alerts,
  obligationOccurrences as occurrences,
  rentCharges,
} from '../database/schema/index.js';
import type { DueItemKind } from '../due-dates/due-date.rules.js';
import { resourcePath } from '../due-dates/resource-links.js';
import { ALERT_TITLES, alertMessage } from './alert-rules.js';
import { effectivelyActive, effectiveState } from './alert-sql.js';
import type { AlertResponseDto, ListAlertsQueryDto } from './dto/alert.dto.js';

const COMPONENT = 'api.alerts';
export const ALERT_NOT_FOUND = 'Alerta no encontrada';

const alertColumns = {
  id: alerts.id,
  type: alerts.type,
  severity: alerts.severity,
  relevantDate: alerts.relevantDate,
  state: effectiveState,
  storedState: alerts.state,
  requiresAttention: effectivelyActive,
  readAt: alerts.readAt,
  dismissedAt: alerts.dismissedAt,
  resolvedAt: alerts.resolvedAt,
  resolutionReason: alerts.resolutionReason,
  occurrenceId: alerts.occurrenceId,
  rentChargeId: alerts.rentChargeId,
  contractId: alerts.contractId,
  hitlRequestId: alerts.hitlRequestId,
  obligationId: occurrences.obligationId,
  rentalId: rentCharges.rentalId,
  createdAt: alerts.createdAt,
  updatedAt: alerts.updatedAt,
};

type AlertRow = Awaited<ReturnType<AlertsService['selectAlerts']>>[number];

/**
 * Alertas internas del usuario autenticado. Leer o descartar una alerta solo
 * cambia la alerta: nunca confirma pagos, cobros, revisiones ni contratos.
 */
@Injectable()
export class AlertsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(
    user: AuthenticatedUser,
    query: ListAlertsQueryDto,
  ): Promise<Page<AlertResponseDto>> {
    const filters: SQL[] = [eq(alerts.ownerId, user.profileId)];
    if (query.state === 'active' || query.requiresAttention === true) {
      filters.push(effectivelyActive);
    } else if (query.requiresAttention === false) {
      filters.push(not(effectivelyActive));
    }
    if (query.state === 'dismissed') {
      filters.push(eq(alerts.state, 'dismissed'));
    } else if (query.state === 'resolved') {
      filters.push(
        or(
          eq(alerts.state, 'resolved'),
          and(eq(alerts.state, 'active'), not(effectivelyActive)),
        )!,
      );
    }
    if (query.read !== undefined) {
      filters.push(
        query.read ? isNotNull(alerts.readAt) : isNull(alerts.readAt),
      );
    }
    if (query.type) filters.push(eq(alerts.type, query.type));
    if (query.severity) filters.push(eq(alerts.severity, query.severity));
    const where = and(...filters)!;
    const order = query.order === 'asc' ? asc : desc;

    const [rows, [total]] = await Promise.all([
      this.selectAlerts(this.db, where)
        .orderBy(order(alerts.createdAt), order(alerts.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ n: count() }).from(alerts).where(where),
    ]);
    return {
      items: rows.map(toAlertResponse),
      page: query.page,
      pageSize: query.pageSize,
      total: total!.n,
    };
  }

  async findOne(
    user: AuthenticatedUser,
    id: string,
  ): Promise<AlertResponseDto> {
    return toAlertResponse(await this.findOwned(this.db, user, id));
  }

  /** Marca la alerta como leída. Repetirlo no cambia nada ni se audita de nuevo. */
  async markRead(
    user: AuthenticatedUser,
    correlationId: string,
    id: string,
  ): Promise<AlertResponseDto> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockOwned(tx, user, id);
      if (current.readAt) return toAlertResponse(current);
      await tx
        .update(alerts)
        .set({ readAt: sql`now()` })
        .where(eq(alerts.id, id));
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'alert.read',
        resource: 'alert',
        resourceId: id,
        details: { type: current.type },
      });
      return toAlertResponse(await this.findOwned(tx, user, id));
    });
  }

  /**
   * Descarta una alerta activa (deja de mostrarse). No altera el recurso
   * relacionado. Una alerta ya resuelta por el sistema responde 409.
   */
  async dismiss(
    user: AuthenticatedUser,
    correlationId: string,
    id: string,
  ): Promise<AlertResponseDto> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockOwned(tx, user, id);
      if (current.storedState === 'dismissed') return toAlertResponse(current);
      if (current.storedState === 'resolved') {
        throw new ConflictException(
          'La alerta ya está resuelta; no necesita descartarse',
        );
      }
      await tx
        .update(alerts)
        .set({ state: 'dismissed', dismissedAt: sql`now()` })
        .where(and(eq(alerts.id, id), eq(alerts.state, 'active')));
      await this.audit.recordUserAction(tx, {
        profileId: user.profileId,
        correlationId,
        component: COMPONENT,
        action: 'alert.dismiss',
        resource: 'alert',
        resourceId: id,
        details: { type: current.type, affectsResource: false },
      });
      return toAlertResponse(await this.findOwned(tx, user, id));
    });
  }

  private selectAlerts(executor: Database | DbTransaction, where: SQL) {
    // Los LEFT JOIN solo aportan el identificador padre para la navegación.
    return executor
      .select(alertColumns)
      .from(alerts)
      .leftJoin(occurrences, eq(occurrences.id, alerts.occurrenceId))
      .leftJoin(rentCharges, eq(rentCharges.id, alerts.rentChargeId))
      .where(where)
      .$dynamic();
  }

  private async findOwned(
    executor: Database | DbTransaction,
    user: AuthenticatedUser,
    id: string,
  ): Promise<AlertRow> {
    const [row] = await this.selectAlerts(
      executor,
      and(eq(alerts.id, id), eq(alerts.ownerId, user.profileId))!,
    );
    if (!row) throw new NotFoundException(ALERT_NOT_FOUND);
    return row;
  }

  private async lockOwned(
    tx: DbTransaction,
    user: AuthenticatedUser,
    id: string,
  ): Promise<AlertRow> {
    const [locked] = await tx
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.id, id), eq(alerts.ownerId, user.profileId)))
      .for('update');
    if (!locked) throw new NotFoundException(ALERT_NOT_FOUND);
    return this.findOwned(tx, user, id);
  }
}

function toAlertResponse(row: AlertRow): AlertResponseDto {
  const [kind, resourceId, parentId]: [DueItemKind, string, string | null] =
    row.occurrenceId
      ? ['obligation_occurrence', row.occurrenceId, row.obligationId]
      : row.rentChargeId
        ? ['rent_charge', row.rentChargeId, row.rentalId]
        : row.contractId
          ? ['contract', row.contractId, null]
          : ['hitl_request', row.hitlRequestId!, null];
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: ALERT_TITLES[row.type],
    message: alertMessage(row.type, row.relevantDate),
    relevantDate: row.relevantDate,
    state: row.state,
    requiresAttention: row.requiresAttention,
    read: row.readAt !== null,
    readAt: row.readAt,
    dismissedAt: row.dismissedAt,
    resolvedAt: row.resolvedAt,
    resolutionReason: row.resolutionReason,
    resource: {
      type: kind,
      id: resourceId,
      path: resourcePath(kind, resourceId, parentId),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
