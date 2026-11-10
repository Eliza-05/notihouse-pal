import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, inArray, ne } from 'drizzle-orm';
import { escapeLikePattern } from '../../common/dto-helpers.js';
import {
  DRIZZLE,
  type Database,
  type DbTransaction,
} from '../../database/database.constants.js';
import {
  obligationOccurrences,
  obligations,
  properties,
  rentals,
} from '../../database/schema/index.js';
import { monthRange, yearMonthOf } from '../../due-dates/calendar.js';
import { DueDateEvaluationService } from '../../due-dates/due-date-evaluation.service.js';
import { WorkflowJobsService } from '../../integrations/workflow-jobs.service.js';
import { TEXT_INGESTION_JOB_TYPE } from '../../ingestion/dto/text-ingestion.dto.js';
import { INGESTION_JOB_TYPES } from '../../ingestion/dto/ingestion.dto.js';
import {
  type ExtractionDto,
  type ResolveCaseDto,
  type ResolveResponseDto,
} from './assistant.dto.js';
import { matchCandidates } from './candidate-matching.js';
import { reminderDaysBeforeFromAbsoluteDay } from './reminder-conversion.js';

const STANDARD_CONSEQUENCES =
  'Aprobar solo confirma. Después debes aplicar. No se cambia ningún pago ya registrado.';
const GUIDED_CONSEQUENCES =
  'Esto solo te lleva a la pantalla correspondiente; no confirma ni registra nada por sí mismo.';
const INFORMATIONAL_CONSEQUENCES =
  'Esto es solo información; no se registró ni se cambió nada.';

interface ObligationCandidate {
  id: string;
  providerName: string;
  concept: string;
  propertyId: string | null;
  dueDay: number | null;
  reminderDaysBefore: number;
  expectedAmount: string | null;
  currency: string;
  propertyName: string | null;
}

interface PropertyCandidate {
  id: string;
  name: string;
}

interface RentalCandidate {
  id: string;
  propertyId: string;
  propertyName: string;
  tenantAlias: string | null;
  dueDay: number;
  expectedAmount: string;
  currency: string;
}

/**
 * Tipos de trabajo cuya extracción puede resolverse aquí: el texto del
 * asistente, la nota de voz (ya transcrita) y el documento (PDF subido o
 * adjunto de Gmail, ya extraído). Cualquier otro (revisiones, mantenimiento)
 * se rechaza con 403: la lista es cerrada.
 */
const RESOLVABLE_JOB_TYPES: readonly string[] = [
  TEXT_INGESTION_JOB_TYPE,
  INGESTION_JOB_TYPES.voice,
  INGESTION_JOB_TYPES.document,
];

/**
 * A-5: un documento solo puede producir la intención `register_invoice`
 * (factura nueva o de una obligación existente). Una factura no puede crear
 * obligaciones recurrentes, arriendos ni declarar pagos o cobros: esas
 * intenciones solo son legítimas cuando la persona las escribe o dicta.
 */
const DOCUMENT_ALLOWED_INTENTS: readonly string[] = ['register_invoice'];

/**
 * Resolución determinística de un mensaje (texto o voz) contra los datos
 * propios del usuario (§19.2-19.3, I2). Solo lectura: nunca escribe una
 * propuesta ni una revisión (eso lo hacen las rutas internas existentes).
 * Nunca llama a Gemini ni a ningún servicio externo.
 */
@Injectable()
export class AssistantResolveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jobs: WorkflowJobsService,
    private readonly dueDates: DueDateEvaluationService,
  ) {}

  async resolve(caseId: string, dto: ResolveCaseDto): Promise<ResolveResponseDto> {
    return this.db.transaction(async (tx) => {
      const claim = await this.jobs.verifyActiveClaim(
        tx,
        dto.jobId,
        dto.claimToken,
        caseId,
      );
      if (!RESOLVABLE_JOB_TYPES.includes(claim.jobType)) {
        throw new ForbiddenException(
          'El tipo de trabajo reclamado no está autorizado para resolver este caso',
        );
      }
      if (
        claim.jobType === INGESTION_JOB_TYPES.document &&
        !DOCUMENT_ALLOWED_INTENTS.includes(dto.extraction.intent)
      ) {
        return unsupported(
          'Un documento solo puede registrar una factura; esa acción debe pedirla la persona por texto o voz. Complétalo manualmente.',
        );
      }
      return this.resolveExtraction(tx, claim.ownerId, dto.extraction);
    });
  }

  private async resolveExtraction(
    tx: DbTransaction,
    ownerId: string,
    extraction: ExtractionDto,
  ): Promise<ResolveResponseDto> {
    // R16: un mensaje con instrucciones incrustadas nunca se convierte en
    // una propuesta aplicable, sin importar la intención declarada.
    if (extraction.containsInstructions) {
      return unsupported(
        'El mensaje parece contener instrucciones para el sistema; no se procesa automáticamente. Complétalo manualmente.',
      );
    }
    switch (extraction.intent) {
      case 'create_recurring_obligation':
        return this.resolveCreateRecurringObligation(tx, ownerId, extraction);
      case 'register_invoice':
        return this.resolveRegisterInvoice(tx, ownerId, extraction);
      case 'update_obligation_schedule':
        return this.resolveUpdateObligationSchedule(tx, ownerId, extraction);
      case 'create_recurring_rental':
        return this.resolveCreateRecurringRental(tx, ownerId, extraction);
      case 'declare_payment':
        return this.resolveDeclarePayment(tx, ownerId, extraction);
      case 'declare_rent_received':
        return this.resolveDeclareRentReceived(tx, ownerId, extraction);
      case 'report_rent_unpaid':
        return this.resolveReportRentUnpaid(tx, ownerId, extraction);
      case 'unsupported':
      default:
        return unsupported(
          'No reconocí ninguna acción conocida en el mensaje. Complétalo manualmente.',
        );
    }
  }

  // ------------------------------------------------------------ obligations

  /** Coincidencia por proveedor (obligatorio) y, si existe, nombre de inmueble. */
  private async findObligationCandidates(
    tx: DbTransaction,
    ownerId: string,
    providerName: string,
    propertyName?: string | null,
  ): Promise<ObligationCandidate[]> {
    const pattern = `%${escapeLikePattern(providerName)}%`;
    const rows = await tx
      .select({
        id: obligations.id,
        providerName: obligations.providerName,
        concept: obligations.concept,
        propertyId: obligations.propertyId,
        dueDay: obligations.dueDay,
        reminderDaysBefore: obligations.reminderDaysBefore,
        expectedAmount: obligations.expectedAmount,
        currency: obligations.currency,
        propertyName: properties.name,
      })
      .from(obligations)
      .leftJoin(properties, eq(properties.id, obligations.propertyId))
      .where(
        and(
          eq(obligations.ownerId, ownerId),
          ne(obligations.status, 'archived'),
          ilike(obligations.providerName, pattern),
        ),
      )
      .limit(20);
    if (!propertyName) return rows;
    const propertyPattern = propertyName.toLowerCase();
    const scoped = rows.filter((r) =>
      r.propertyName?.toLowerCase().includes(propertyPattern),
    );
    // Si el nombre de inmueble no coincide con ninguna, no se descarta todo
    // el resultado (puede ser un inmueble mal transcrito): se sigue con el
    // conjunto completo por proveedor.
    return scoped.length > 0 ? scoped : rows;
  }

  private async findPropertyCandidates(
    tx: DbTransaction,
    ownerId: string,
    propertyName: string,
  ): Promise<PropertyCandidate[]> {
    const pattern = `%${escapeLikePattern(propertyName)}%`;
    return tx
      .select({ id: properties.id, name: properties.name })
      .from(properties)
      .where(
        and(
          eq(properties.ownerId, ownerId),
          eq(properties.status, 'active'),
          ilike(properties.name, pattern),
        ),
      )
      .limit(20);
  }

  private async resolveCreateRecurringObligation(
    tx: DbTransaction,
    ownerId: string,
    extraction: ExtractionDto,
  ): Promise<ResolveResponseDto> {
    const missing: string[] = [];
    if (!extraction.providerName) missing.push('providerName');
    if (!extraction.concept) missing.push('concept');
    if (!extraction.category) missing.push('category');
    if (extraction.dueDay == null) missing.push('dueDay');
    if (missing.length > 0) {
      return needsCompletion(
        missing,
        'Me falta información para crear la obligación: ' + missing.join(', ') + '.',
      );
    }
    const warnings: string[] = [];
    const propertyId = extraction.propertyName
      ? await this.resolveOptionalProperty(tx, ownerId, extraction.propertyName, warnings)
      : undefined;
    const obligation: Record<string, unknown> = {
      providerName: extraction.providerName,
      concept: extraction.concept,
      category: extraction.category,
      frequency: extraction.frequency ?? 'monthly',
      dueDay: extraction.dueDay,
      ...(extraction.reminderDaysBefore != null
        ? { reminderDaysBefore: extraction.reminderDaysBefore }
        : {}),
      ...(extraction.amount ? { expectedAmount: extraction.amount } : {}),
      currency: extraction.currency ?? 'COP',
      ...(propertyId ? { propertyId } : {}),
    };
    return {
      outcome: 'applicable',
      proposedData: {
        action: 'create_recurring_obligation',
        data: { obligation },
      },
      choices: [],
      missing: [],
      warnings,
      summary: `Crear la obligación recurrente ${extraction.providerName} (día ${extraction.dueDay} de cada mes).`,
      consequences: STANDARD_CONSEQUENCES,
    };
  }

  /** Propiedad opcional: si es ambigua o no existe, se omite (nunca bloquea). */
  private async resolveOptionalProperty(
    tx: DbTransaction,
    ownerId: string,
    propertyName: string,
    warnings: string[],
  ): Promise<string | undefined> {
    const candidates = await this.findPropertyCandidates(tx, ownerId, propertyName);
    const match = matchCandidates(candidates);
    if (match.kind === 'one') return match.candidate.id;
    if (match.kind === 'none') {
      warnings.push(`No encontré un inmueble propio que coincida con "${propertyName}"`);
    } else {
      warnings.push(
        `"${propertyName}" coincide con varios inmuebles; no se asoció ninguno`,
      );
    }
    return undefined;
  }

  private async resolveRegisterInvoice(
    tx: DbTransaction,
    ownerId: string,
    extraction: ExtractionDto,
  ): Promise<ResolveResponseDto> {
    const missing: string[] = [];
    if (!extraction.providerName) missing.push('providerName');
    if (!extraction.amount) missing.push('amount');
    if (!extraction.dueDate) missing.push('dueDate');
    if (missing.length > 0) {
      return needsCompletion(
        missing,
        'Me falta información para registrar la factura: ' + missing.join(', ') + '.',
      );
    }
    const candidates = await this.findObligationCandidates(
      tx,
      ownerId,
      extraction.providerName!,
      extraction.propertyName,
    );
    const match = matchCandidates(candidates);
    const dueDate = extraction.dueDate!;
    const month = yearMonthOf(extraction.month ?? dueDate.slice(0, 7) + '-01');
    const { start: periodStart, end: periodEnd } = monthRange(month);

    if (match.kind === 'many') {
      return needsChoiceFromObligations(
        match.candidates,
        `Varias obligaciones coinciden con "${extraction.providerName}". ¿Cuál es?`,
      );
    }
    if (match.kind === 'none') {
      const stillMissing = [
        ...(!extraction.concept ? ['concept'] : []),
        ...(!extraction.category ? ['category'] : []),
      ];
      if (stillMissing.length > 0) {
        return needsCompletion(
          stillMissing,
          `No encontré una obligación de "${extraction.providerName}": para crearla me falta ${stillMissing.join(', ')}.`,
        );
      }
      const propertyId = extraction.propertyName
        ? await this.resolveOptionalProperty(tx, ownerId, extraction.propertyName, [])
        : undefined;
      return {
        outcome: 'applicable',
        proposedData: {
          action: 'create_obligation_with_occurrence',
          data: {
            obligation: {
              providerName: extraction.providerName,
              concept: extraction.concept,
              category: extraction.category,
              currency: extraction.currency ?? 'COP',
              ...(propertyId ? { propertyId } : {}),
            },
            occurrence: { periodStart, periodEnd, dueDate, amount: extraction.amount },
          },
        },
        choices: [],
        missing: [],
        warnings: [],
        summary: `Registrar una nueva obligación de ${extraction.providerName} por ${extraction.amount}, vence ${dueDate}.`,
        consequences: STANDARD_CONSEQUENCES,
      };
    }

    const obligation = match.candidate;
    const [existingOccurrence] = await tx
      .select({
        id: obligationOccurrences.id,
        status: obligationOccurrences.status,
        amount: obligationOccurrences.amount,
        dueDate: obligationOccurrences.dueDate,
      })
      .from(obligationOccurrences)
      .where(
        and(
          eq(obligationOccurrences.obligationId, obligation.id),
          eq(obligationOccurrences.periodStart, periodStart),
        ),
      );
    // Case D: un período ya confirmado (o anulado) nunca se sobrescribe ni se
    // duplica: se informa y no se propone ninguna acción aplicable.
    if (existingOccurrence && existingOccurrence.status !== 'pending') {
      return {
        outcome: 'informational',
        proposedData: null,
        choices: [],
        missing: [],
        warnings: [],
        summary: `El período ${periodStart.slice(0, 7)} de ${obligation.providerName} ya está cerrado (${existingOccurrence.status}); la factura no lo modifica. Si es una corrección, hazla manualmente.`,
        consequences: INFORMATIONAL_CONSEQUENCES,
      };
    }
    // Case C: la misma factura otra vez (mismo monto y vencimiento) no genera
    // otro cambio que aplicar.
    if (
      existingOccurrence &&
      existingOccurrence.amount != null &&
      Number(existingOccurrence.amount) === Number(extraction.amount) &&
      String(existingOccurrence.dueDate).slice(0, 10) === dueDate
    ) {
      return {
        outcome: 'informational',
        proposedData: null,
        choices: [],
        missing: [],
        warnings: [],
        summary: `El período ${periodStart.slice(0, 7)} de ${obligation.providerName} ya tiene esos mismos datos (${extraction.amount}, vence ${dueDate}); no hay nada que cambiar.`,
        consequences: INFORMATIONAL_CONSEQUENCES,
      };
    }
    if (existingOccurrence) {
      return {
        outcome: 'applicable',
        proposedData: {
          action: 'update_occurrence_details',
          data: {
            obligationId: obligation.id,
            occurrenceId: existingOccurrence.id,
            amount: extraction.amount,
            dueDate,
          },
        },
        choices: [],
        missing: [],
        warnings: [],
        summary: `Completar el período de ${obligation.providerName} con el monto y la fecha reales.`,
        consequences: STANDARD_CONSEQUENCES,
      };
    }
    return {
      outcome: 'applicable',
      proposedData: {
        action: 'create_obligation_occurrence',
        data: {
          obligationId: obligation.id,
          periodStart,
          periodEnd,
          dueDate,
          amount: extraction.amount,
        },
      },
      choices: [],
      missing: [],
      warnings: [],
      summary: `Registrar el período de ${obligation.providerName} por ${extraction.amount}, vence ${dueDate}.`,
      consequences: STANDARD_CONSEQUENCES,
    };
  }

  private async resolveUpdateObligationSchedule(
    tx: DbTransaction,
    ownerId: string,
    extraction: ExtractionDto,
  ): Promise<ResolveResponseDto> {
    if (!extraction.providerName) {
      return needsCompletion(
        ['providerName'],
        'No sé a qué obligación te refieres: indica el proveedor.',
      );
    }
    const hasChange =
      extraction.dueDay != null ||
      extraction.reminderDaysBefore != null ||
      extraction.reminderDay != null ||
      extraction.amount != null;
    if (!hasChange) {
      return needsCompletion(
        ['changes'],
        'No identifiqué qué quieres cambiar (día, aviso o monto).',
      );
    }
    const candidates = await this.findObligationCandidates(
      tx,
      ownerId,
      extraction.providerName,
      extraction.propertyName,
    );
    const match = matchCandidates(candidates);
    if (match.kind === 'none') {
      return needsCompletion(
        ['obligationId'],
        `No encontré ninguna obligación propia que coincida con "${extraction.providerName}".`,
      );
    }
    if (match.kind === 'many') {
      return needsChoiceFromObligations(
        match.candidates,
        `Varias obligaciones coinciden con "${extraction.providerName}". ¿Cuál es?`,
      );
    }

    const obligation = match.candidate;
    const warnings: string[] = [];
    const expected: Record<string, unknown> = {};
    const changes: Record<string, unknown> = {};
    if (extraction.dueDay != null) {
      expected.dueDay = obligation.dueDay;
      changes.dueDay = extraction.dueDay;
    }
    if (extraction.reminderDaysBefore != null) {
      expected.reminderDaysBefore = obligation.reminderDaysBefore;
      changes.reminderDaysBefore = extraction.reminderDaysBefore;
    } else if (extraction.reminderDay != null) {
      const targetDueDay = extraction.dueDay ?? obligation.dueDay;
      if (targetDueDay == null) {
        warnings.push(
          'No se pudo convertir el aviso porque la obligación no tiene día de vencimiento',
        );
      } else {
        expected.reminderDaysBefore = obligation.reminderDaysBefore;
        changes.reminderDaysBefore = reminderDaysBeforeFromAbsoluteDay(
          targetDueDay,
          extraction.reminderDay,
        );
      }
    }
    if (extraction.amount != null) {
      expected.expectedAmount = obligation.expectedAmount;
      changes.expectedAmount = extraction.amount;
    }
    if (Object.keys(changes).length === 0) {
      return needsCompletion(
        ['changes'],
        'No identifiqué qué quieres cambiar (día, aviso o monto).',
      );
    }
    return {
      outcome: 'applicable',
      proposedData: {
        action: 'update_obligation_schedule',
        data: { obligationId: obligation.id, expected, changes },
      },
      choices: [],
      missing: [],
      warnings,
      summary: `Cambiar la agenda de ${obligation.providerName}${obligation.propertyName ? ` (${obligation.propertyName})` : ''}.`,
      consequences: STANDARD_CONSEQUENCES,
    };
  }

  // ----------------------------------------------------------------- rentals

  private async resolveCreateRecurringRental(
    tx: DbTransaction,
    ownerId: string,
    extraction: ExtractionDto,
  ): Promise<ResolveResponseDto> {
    const missing: string[] = [];
    if (!extraction.propertyName) missing.push('propertyName');
    if (!extraction.amount) missing.push('amount');
    if (extraction.dueDay == null) missing.push('dueDay');
    if (missing.length > 0) {
      return needsCompletion(
        missing,
        'Me falta información para registrar el arriendo: ' + missing.join(', ') + '.',
      );
    }
    const candidates = await this.findPropertyCandidates(
      tx,
      ownerId,
      extraction.propertyName!,
    );
    const match = matchCandidates(candidates);
    if (match.kind === 'none') {
      return needsCompletion(
        ['propertyName'],
        `No encontré un inmueble propio que coincida con "${extraction.propertyName}".`,
      );
    }
    if (match.kind === 'many') {
      return {
        outcome: 'needs_choice',
        proposedData: null,
        choices: match.candidates.map((p) => ({ key: p.id, label: p.name })),
        missing: [],
        warnings: [],
        summary: `Varios inmuebles coinciden con "${extraction.propertyName}". ¿Cuál es?`,
        consequences: STANDARD_CONSEQUENCES,
      };
    }
    const today = this.dueDates.reference().today;
    return {
      outcome: 'applicable',
      proposedData: {
        action: 'create_recurring_rental',
        data: {
          rental: {
            propertyId: match.candidate.id,
            expectedAmount: extraction.amount,
            dueDay: extraction.dueDay,
            startsOn: today,
            ...(extraction.tenantAlias
              ? { tenantAlias: extraction.tenantAlias }
              : {}),
          },
        },
      },
      choices: [],
      missing: [],
      warnings: [],
      summary: `Registrar el cobro de arriendo de ${match.candidate.name} por ${extraction.amount}, día ${extraction.dueDay} de cada mes.`,
      consequences: STANDARD_CONSEQUENCES,
    };
  }

  private async findRentalCandidates(
    tx: DbTransaction,
    ownerId: string,
    propertyName?: string | null,
    tenantAlias?: string | null,
  ): Promise<RentalCandidate[]> {
    const rows = await tx
      .select({
        id: rentals.id,
        propertyId: rentals.propertyId,
        propertyName: properties.name,
        tenantAlias: rentals.tenantAlias,
        dueDay: rentals.dueDay,
        expectedAmount: rentals.expectedAmount,
        currency: rentals.currency,
      })
      .from(rentals)
      .innerJoin(properties, eq(properties.id, rentals.propertyId))
      .where(and(eq(rentals.ownerId, ownerId), ne(rentals.status, 'ended')))
      .limit(20);
    let scoped = rows;
    if (propertyName) {
      const pattern = propertyName.toLowerCase();
      const byProperty = rows.filter((r) =>
        r.propertyName.toLowerCase().includes(pattern),
      );
      if (byProperty.length > 0) scoped = byProperty;
    }
    if (tenantAlias) {
      const pattern = tenantAlias.toLowerCase();
      const byTenant = scoped.filter((r) =>
        r.tenantAlias?.toLowerCase().includes(pattern),
      );
      if (byTenant.length > 0) scoped = byTenant;
    }
    return scoped;
  }

  private async resolveDeclareRentReceived(
    tx: DbTransaction,
    ownerId: string,
    extraction: ExtractionDto,
  ): Promise<ResolveResponseDto> {
    const candidates = await this.findRentalCandidates(
      tx,
      ownerId,
      extraction.propertyName,
      extraction.tenantAlias,
    );
    const match = matchCandidates(candidates);
    if (match.kind === 'none') {
      return needsCompletion(
        ['propertyName'],
        'No encontré ningún arriendo propio que coincida con el mensaje.',
      );
    }
    if (match.kind === 'many') {
      return {
        outcome: 'needs_choice',
        proposedData: null,
        choices: match.candidates.map((r) => ({
          key: r.id,
          label: `${r.propertyName}${r.tenantAlias ? ` · ${r.tenantAlias}` : ''}`,
        })),
        missing: [],
        warnings: [],
        summary: 'Varios arriendos coinciden con el mensaje. ¿Cuál es?',
        consequences: GUIDED_CONSEQUENCES,
      };
    }
    return {
      outcome: 'guided_manual',
      proposedData: { guided: { kind: 'declare_rent_received', rentalId: match.candidate.id } },
      choices: [],
      missing: [],
      warnings: [],
      summary: `Ir a confirmar la recepción del cobro de ${match.candidate.propertyName}.`,
      consequences: GUIDED_CONSEQUENCES,
    };
  }

  private async resolveReportRentUnpaid(
    tx: DbTransaction,
    ownerId: string,
    extraction: ExtractionDto,
  ): Promise<ResolveResponseDto> {
    const candidates = await this.findRentalCandidates(
      tx,
      ownerId,
      extraction.propertyName,
      extraction.tenantAlias,
    );
    const match = matchCandidates(candidates);
    if (match.kind === 'none') {
      return needsCompletion(
        ['propertyName'],
        'No encontré ningún arriendo propio que coincida con el mensaje.',
      );
    }
    if (match.kind === 'many') {
      return {
        outcome: 'needs_choice',
        proposedData: null,
        choices: match.candidates.map((r) => ({
          key: r.id,
          label: `${r.propertyName}${r.tenantAlias ? ` · ${r.tenantAlias}` : ''}`,
        })),
        missing: [],
        warnings: [],
        summary: 'Varios arriendos coinciden con el mensaje. ¿Cuál es?',
        consequences: INFORMATIONAL_CONSEQUENCES,
      };
    }
    return {
      outcome: 'informational',
      proposedData: null,
      choices: [],
      missing: [],
      warnings: [],
      summary: `Revisa los cobros abiertos de ${match.candidate.propertyName} en el detalle del arriendo. NotiHouse-Pal no envía mensajes al arrendatario.`,
      consequences: INFORMATIONAL_CONSEQUENCES,
    };
  }

  private async resolveDeclarePayment(
    tx: DbTransaction,
    ownerId: string,
    extraction: ExtractionDto,
  ): Promise<ResolveResponseDto> {
    if (!extraction.providerName) {
      return needsCompletion(
        ['providerName'],
        'No sé a qué obligación te refieres: indica el proveedor.',
      );
    }
    const candidates = await this.findObligationCandidates(
      tx,
      ownerId,
      extraction.providerName,
      extraction.propertyName,
    );
    const match = matchCandidates(candidates);
    if (match.kind === 'none') {
      return needsCompletion(
        ['obligationId'],
        `No encontré ninguna obligación propia que coincida con "${extraction.providerName}".`,
      );
    }
    if (match.kind === 'many') {
      return needsChoiceFromObligations(
        match.candidates,
        `Varias obligaciones coinciden con "${extraction.providerName}". ¿Cuál es?`,
      );
    }
    const obligation = match.candidate;
    const [occurrence] = await tx
      .select({ id: obligationOccurrences.id, dueDate: obligationOccurrences.dueDate })
      .from(obligationOccurrences)
      .where(
        and(
          eq(obligationOccurrences.obligationId, obligation.id),
          inArray(obligationOccurrences.status, ['pending', 'overdue']),
        ),
      )
      .orderBy(asc(obligationOccurrences.dueDate))
      .limit(1);
    if (!occurrence) {
      return {
        outcome: 'informational',
        proposedData: null,
        choices: [],
        missing: [],
        warnings: [],
        summary: `No encontré períodos pendientes de ${obligation.providerName} para confirmar.`,
        consequences: INFORMATIONAL_CONSEQUENCES,
      };
    }
    return {
      outcome: 'guided_manual',
      proposedData: {
        guided: {
          kind: 'declare_payment',
          obligationId: obligation.id,
          occurrenceId: occurrence.id,
        },
      },
      choices: [],
      missing: [],
      warnings: [],
      summary: `Ir a confirmar el pago de ${obligation.providerName} (vence ${occurrence.dueDate}).`,
      consequences: GUIDED_CONSEQUENCES,
    };
  }
}

function unsupported(summary: string): ResolveResponseDto {
  return {
    outcome: 'unsupported',
    proposedData: null,
    choices: [],
    missing: [],
    warnings: [],
    summary,
    consequences: 'No se registró ni se cambió nada.',
  };
}

function needsCompletion(missing: string[], summary: string): ResolveResponseDto {
  return {
    outcome: 'needs_completion',
    proposedData: null,
    choices: [],
    missing,
    warnings: [],
    summary,
    consequences: 'No se registró ni se cambió nada; completa el formulario manualmente.',
  };
}

function needsChoiceFromObligations(
  candidates: ObligationCandidate[],
  summary: string,
): ResolveResponseDto {
  return {
    outcome: 'needs_choice',
    proposedData: null,
    choices: candidates.map((o) => ({
      key: o.id,
      label: `${o.providerName} · ${o.concept}${o.propertyName ? ` · ${o.propertyName}` : ''}`,
    })),
    missing: [],
    warnings: [],
    summary,
    consequences: STANDARD_CONSEQUENCES,
  };
}
