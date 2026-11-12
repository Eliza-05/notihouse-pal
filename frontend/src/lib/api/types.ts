/**
 * Tipos del contrato de la API, tomados de
 * docs/frontend/GUIA_FRONTEND_NOTIHOUSE_PAL.md (§6 y §11.3) y de la guía de
 * integración §20 (contratos nuevos: búsquedas, recurrencia, asistente).
 *
 * Reglas que NO hay que romper al extender este archivo (ver §4 y §10.5 de la guía):
 * - El dinero viaja como TEXTO decimal ("145000.00"), nunca como number.
 *   No convertir con Number()/parseFloat ni operar aritméticamente sobre él.
 * - Las fechas de calendario viajan como "YYYY-MM-DD" (sin hora ni zona).
 *   No construir con `new Date('YYYY-MM-DD')` directo: se interpreta como UTC
 *   y puede mostrar el día anterior según la zona del navegador.
 * - Los instantes (createdAt, updatedAt, dueAt, ...) son ISO 8601 completo.
 */

/** "145000.00" — nunca convertir a number para operar. */
export type MoneyString = string

/** "YYYY-MM-DD" — fecha de calendario, sin componente de hora/zona. */
export type CalendarDate = string

/** ISO 8601 completo (instante). */
export type IsoInstant = string

/** Envoltorio de paginación que usan todos los listados (`page`, `pageSize`, `total`). */
export interface Page<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

// ---------------------------------------------------------------------------
// Autenticación (§6.1, §7)
// ---------------------------------------------------------------------------

export interface LoginRequest {
  email: string
  password: string
}

export interface AuthenticatedUser {
  id: string
  email: string
  displayName: string | null
}

export interface LoginResponse {
  accessToken: string
  tokenType: 'Bearer'
  /** Segundos de validez desde el momento de la respuesta (hoy, 1800 = 30 min). */
  expiresIn: number
  user: AuthenticatedUser
}

// ---------------------------------------------------------------------------
// Formas de error que puede devolver el backend (ver §11.6)
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  statusCode?: number
  /** Puede ser un string único o una lista (errores de validación por campo). */
  message?: string | string[]
  error?: string
  /** Código funcional adicional (p. ej. KILL_SWITCH_ACTIVE, CONTRADICTING_SOURCE). */
  code?: string
}

// ---------------------------------------------------------------------------
// Inmuebles (§6.2)
// ---------------------------------------------------------------------------

export type PropertyStatus = 'active' | 'inactive' | 'archived'

export interface Property {
  id: string
  name: string
  address: string | null
  description: string | null
  status: PropertyStatus
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

export interface CreatePropertyInput {
  name: string
  address?: string | null
  description?: string | null
}

export interface UpdatePropertyInput {
  name?: string
  address?: string | null
  description?: string | null
  status?: PropertyStatus
}

export interface ListPropertiesParams {
  page?: number
  pageSize?: number
  status?: PropertyStatus
  /** N3 (obligatoria): búsqueda por nombre, 2-60 caracteres. */
  q?: string
}

// ---------------------------------------------------------------------------
// Obligaciones y períodos (§6.3)
// ---------------------------------------------------------------------------

export type ObligationCategory =
  | 'water'
  | 'electricity'
  | 'gas'
  | 'internet'
  | 'mobile'
  | 'administration'
  | 'other'

export type ObligationFrequency = 'monthly' | 'bimonthly' | 'quarterly' | 'semiannual' | 'annual'
export type ObligationStatus = 'active' | 'paused' | 'archived'

export interface Obligation {
  id: string
  propertyId: string | null
  providerName: string
  concept: string
  category: ObligationCategory
  expectedAmount: MoneyString | null
  currency: string
  frequency: ObligationFrequency
  dueDay: number | null
  reminderDaysBefore: number
  startsOn: CalendarDate | null
  status: ObligationStatus
  /** N6 (propuesto): generar automáticamente los próximos períodos. */
  autoGenerate: boolean
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

/** Respuesta del archivado: la obligación y cuántos períodos abiertos se conservan sin cambios. */
export interface ArchivedObligation extends Obligation {
  pendingOccurrences: number
}

export interface CreateObligationInput {
  propertyId?: string
  providerName: string
  concept: string
  category: ObligationCategory
  expectedAmount?: MoneyString
  currency?: string
  frequency?: ObligationFrequency
  dueDay?: number
  reminderDaysBefore?: number
  startsOn?: CalendarDate
  status?: 'active' | 'paused'
  autoGenerate?: boolean
}

export interface UpdateObligationInput {
  propertyId?: string | null
  providerName?: string
  concept?: string
  category?: ObligationCategory
  expectedAmount?: MoneyString | null
  frequency?: ObligationFrequency
  dueDay?: number | null
  reminderDaysBefore?: number
  startsOn?: CalendarDate | null
  status?: ObligationStatus
  autoGenerate?: boolean
}

export interface ListObligationsParams {
  page?: number
  pageSize?: number
  propertyId?: string
  status?: ObligationStatus
  category?: ObligationCategory
  /** N3 (obligatoria): proveedor y concepto, 2-60 caracteres. */
  q?: string
  /** N4 (recomendada): sin inmueble asignado. Incompatible con propertyId. */
  unassigned?: boolean
}

export type OccurrenceStatus = 'pending' | 'overdue' | 'paid' | 'attended' | 'cancelled'

export interface ObligationOccurrence {
  id: string
  obligationId: string
  periodStart: CalendarDate
  periodEnd: CalendarDate
  amount: MoneyString | null
  currency: string
  dueDate: CalendarDate
  status: OccurrenceStatus
  confirmedAt: IsoInstant | null
  confirmedBy: string | null
  confirmationReference: string | null
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

export interface CreateOccurrenceInput {
  periodStart: CalendarDate
  periodEnd: CalendarDate
  dueDate: CalendarDate
  amount?: MoneyString
}

export interface UpdateOccurrenceInput {
  periodStart?: CalendarDate
  periodEnd?: CalendarDate
  dueDate?: CalendarDate
  amount?: MoneyString | null
  status?: 'cancelled'
}

export type ConfirmationResult = 'paid' | 'attended'

export interface ConfirmOccurrenceInput {
  result: ConfirmationResult
  reference?: string
}

// ---------------------------------------------------------------------------
// Arriendos y cobros (§6.4)
// ---------------------------------------------------------------------------

export type RentalStatus = 'active' | 'suspended' | 'ended'

export interface Rental {
  id: string
  propertyId: string
  tenantAlias: string | null
  expectedAmount: MoneyString
  currency: string
  dueDay: number
  startsOn: CalendarDate
  endsOn: CalendarDate | null
  status: RentalStatus
  autoGenerate: boolean
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

export interface CreateRentalInput {
  propertyId: string
  tenantAlias?: string
  expectedAmount: MoneyString
  currency?: string
  dueDay: number
  startsOn: CalendarDate
  endsOn?: CalendarDate
  status?: 'active' | 'suspended'
  autoGenerate?: boolean
}

export interface UpdateRentalInput {
  tenantAlias?: string | null
  expectedAmount?: MoneyString
  dueDay?: number
  startsOn?: CalendarDate
  endsOn?: CalendarDate | null
  status?: RentalStatus
  autoGenerate?: boolean
}

export interface ListRentalsParams {
  page?: number
  pageSize?: number
  propertyId?: string
  status?: RentalStatus
}

export type RentChargeStatus = 'expected' | 'pending' | 'overdue' | 'received' | 'cancelled'

export interface RentCharge {
  id: string
  rentalId: string
  periodStart: CalendarDate
  periodEnd: CalendarDate
  expectedAmount: MoneyString
  currency: string
  dueDate: CalendarDate
  status: RentChargeStatus
  confirmedAt: IsoInstant | null
  confirmedBy: string | null
  confirmationEvidence: string | null
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

export interface CreateChargeInput {
  periodStart: CalendarDate
  periodEnd: CalendarDate
  dueDate: CalendarDate
  expectedAmount?: MoneyString
}

export interface UpdateChargeInput {
  periodStart?: CalendarDate
  periodEnd?: CalendarDate
  dueDate?: CalendarDate
  expectedAmount?: MoneyString
  status?: 'cancelled'
}

export interface ConfirmChargeInput {
  evidence: string
}

export interface ListChargesParams {
  page?: number
  pageSize?: number
  status?: RentChargeStatus
  periodFrom?: CalendarDate
  periodTo?: CalendarDate
}

// ---------------------------------------------------------------------------
// Contratos (§6.5)
// ---------------------------------------------------------------------------

export type ContractStatus = 'active' | 'expired' | 'terminated'

export interface Contract {
  id: string
  propertyId: string
  rentalId: string | null
  startsOn: CalendarDate
  endsOn: CalendarDate
  noticePeriodDays: number | null
  status: ContractStatus
  documentId: string | null
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

export interface CreateContractInput {
  propertyId: string
  rentalId?: string
  startsOn: CalendarDate
  endsOn: CalendarDate
  noticePeriodDays?: number
  documentId?: string
}

export interface UpdateContractInput {
  startsOn?: CalendarDate
  endsOn?: CalendarDate
  noticePeriodDays?: number | null
  documentId?: string | null
  status?: ContractStatus
}

export interface ListContractsParams {
  page?: number
  pageSize?: number
  propertyId?: string
  rentalId?: string
  status?: ContractStatus
  endsFrom?: CalendarDate
  endsTo?: CalendarDate
}

// ---------------------------------------------------------------------------
// Dashboard (§6.6)
// ---------------------------------------------------------------------------

export interface MoneyRow {
  currency: string
  total: MoneyString
  count: number
  withoutAmount: number
}

export interface MonthMoneyRow {
  currency: string
  expected: MoneyString
  confirmed: MoneyString
}

export interface DashboardSummary {
  referenceDate: CalendarDate
  timeZone: string
  properties: { total: number; active: number }
  obligations: {
    active: number
    periodsPending: number
    periodsOverdue: number
    periodsDueSoon: number
    periodsConfirmed: number
  }
  rentCharges: { pending: number; overdue: number; dueSoon: number; received: number }
  contracts: { active: number; endingSoon: number; endPassed: number }
  hitl: { pending: number }
  alerts: { active: number; unread: number }
  cases: { open: number }
  money: {
    note: string
    obligationsOpen: MoneyRow[]
    rentOpen: MoneyRow[]
    month: { start: CalendarDate; end: CalendarDate }
    obligationsThisMonth: MonthMoneyRow[]
    rentThisMonth: MonthMoneyRow[]
  }
}

// ---------------------------------------------------------------------------
// Bandeja de atención (§6.7)
// ---------------------------------------------------------------------------

export type AttentionKind = 'obligation_occurrence' | 'rent_charge' | 'contract' | 'hitl_request'
export type AttentionCondition = 'upcoming' | 'due_today' | 'overdue' | 'pending' | 'due_soon'
export type SuggestedAction =
  | 'confirm_payment'
  | 'confirm_receipt'
  | 'review_contract'
  | 'decide_review'
  | 'view_review'

export interface AttentionItem {
  kind: AttentionKind
  id: string
  title: string
  description: string
  relevantDate: CalendarDate
  dueAt: IsoInstant | null
  status: string
  condition: AttentionCondition
  priority: 1 | 2 | 3 | 4
  daysUntil: number
  amount: MoneyString | null
  currency: string | null
  suggestedAction: SuggestedAction
  resource: { type: AttentionKind; id: string; path: string }
  alert: { id: string; read: boolean } | null
}

export interface AttentionPage {
  referenceDate: CalendarDate
  items: AttentionItem[]
  page: number
  pageSize: number
  total: number
}

export interface ListAttentionParams {
  page?: number
  pageSize?: number
  kind?: AttentionKind
}

// ---------------------------------------------------------------------------
// Alertas (§6.8, CONTRATO_ETAPA8)
// ---------------------------------------------------------------------------

export type AlertType =
  | 'obligation_due_soon'
  | 'obligation_overdue'
  | 'rent_charge_due_soon'
  | 'rent_charge_overdue'
  | 'contract_ending_soon'
  | 'contract_end_passed'
  | 'hitl_pending'
  | 'hitl_due_soon'
  | 'hitl_overdue'
export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertState = 'active' | 'dismissed' | 'resolved'
export type AlertResolutionReason = 'resource_closed' | 'superseded' | 'no_longer_applicable'

export interface Alert {
  id: string
  type: AlertType
  severity: AlertSeverity
  title: string
  message: string
  relevantDate: CalendarDate
  state: AlertState
  requiresAttention: boolean
  read: boolean
  readAt: IsoInstant | null
  dismissedAt: IsoInstant | null
  resolvedAt: IsoInstant | null
  resolutionReason: AlertResolutionReason | null
  resource: { type: string; id: string; path: string }
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

export interface ListAlertsParams {
  page?: number
  pageSize?: number
  state?: AlertState
  read?: boolean
  type?: AlertType
  severity?: AlertSeverity
  requiresAttention?: boolean
  order?: 'asc' | 'desc'
}

export interface AlertSummary {
  active: number
  unread: number
  criticalUnread: number
  latestCreatedAt: IsoInstant | null
  serverTime: IsoInstant
}

export interface SystemStatus {
  limited: boolean
  limitedFunctions: { scope: string; label: string; since: IsoInstant }[]
  serverTime: IsoInstant
}

// ---------------------------------------------------------------------------
// Casos (§6.9)
// ---------------------------------------------------------------------------

export type CaseType = 'household_obligation' | 'rent_collection' | 'contract_review'
export type CaseSource = 'form' | 'document' | 'gmail' | 'voice'
export type CaseStatus = 'received' | 'processing' | 'awaiting_human' | 'completed' | 'failed' | 'cancelled'

export interface Case {
  id: string
  correlationId: string
  type: CaseType
  source: CaseSource
  status: CaseStatus
  obligationId: string | null
  rentalId: string | null
  contractId: string | null
  statusReason: string | null
  closedAt: IsoInstant | null
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

export interface ListCasesParams {
  page?: number
  pageSize?: number
  status?: CaseStatus
  type?: CaseType
}

// ---------------------------------------------------------------------------
// Propuestas (§6.10)
// ---------------------------------------------------------------------------

export type ProposalSource = 'llm' | 'ocr' | 'stt' | 'user'
export type ProposalReviewStatus = 'pending_review' | 'accepted' | 'rejected' | 'superseded'

export interface Proposal {
  id: string
  caseId: string
  version: number
  source: ProposalSource
  proposedData: unknown
  evidence: unknown
  confidence: string | null
  documentId: string | null
  reviewStatus: ProposalReviewStatus
  reviewedAt: IsoInstant | null
  reviewedBy: string | null
  createdAt: IsoInstant
  updatedAt: IsoInstant
  /**
   * Fecha en que la propuesta se aplicó a los datos de negocio. `null` = aún no aplicada;
   * `undefined` = el backend desplegado todavía no informa este dato (no asumir ni aplicada ni pendiente).
   */
  appliedAt?: IsoInstant | null
}

export interface ListProposalsParams {
  reviewStatus?: ProposalReviewStatus
}

// ---------------------------------------------------------------------------
// Revisión humana — HITL (§6.11)
// ---------------------------------------------------------------------------

export type HitlDecisionType =
  | 'data_confirmation'
  | 'conflict_resolution'
  | 'reminder_approval'
  | 'contract_review'
  | 'other'
export type HitlStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'

export interface HitlChoice {
  key: string
  label: string
}

export interface HitlOptions {
  summary?: string
  choices?: HitlChoice[]
  context?: Record<string, unknown>
}

export interface HitlDecision {
  outcome: 'approved' | 'rejected'
  choice?: string
  /** A-7: revisión de aprobación que el backend creó al elegir una alternativa (archivar / modificar). */
  followUpRequestId?: string
  comment?: string
}

export interface HitlRequest {
  id: string
  caseId: string
  proposalId: string | null
  decisionType: HitlDecisionType
  status: HitlStatus
  overdue: boolean
  options: HitlOptions
  decision: HitlDecision | null
  createdAt: IsoInstant
  dueAt: IsoInstant
  respondedAt: IsoInstant | null
  updatedAt: IsoInstant
}

export interface HitlDetail extends HitlRequest {
  proposal: Proposal | null
}

export interface ListHitlParams {
  page?: number
  pageSize?: number
  status?: HitlStatus
  caseId?: string
}

export interface DecideHitlInput {
  decision: 'approved' | 'rejected'
  choice?: string
  comment?: string
}

// ---------------------------------------------------------------------------
// Aplicar propuesta (§6.12)
// ---------------------------------------------------------------------------

export type ProposalAction =
  | 'create_obligation_occurrence'
  | 'create_obligation_with_occurrence'
  | 'create_recurring_obligation'
  | 'update_obligation_schedule'
  | 'update_occurrence_details'
  | 'create_recurring_rental'

export interface AppliedResource {
  type: 'obligation_occurrence' | 'obligation' | 'rental'
  id: string
  obligationId: string | null
  status: string
}

export interface ProposalApplicationResponse {
  caseId: string
  proposalId: string
  proposalVersion: number
  hitlRequestId: string
  action: ProposalAction
  status: 'applied'
  alreadyApplied: boolean
  appliedAt: IsoInstant
  resource: AppliedResource
  createdObligationId: string | null
  createdRentalId: string | null
  correlationId: string
}

// ---------------------------------------------------------------------------
// Documentos y voz (§6.13, §6.14)
// ---------------------------------------------------------------------------

export type DocumentType = 'invoice' | 'contract' | 'payment_receipt' | 'voice_note' | 'other'

export interface IngestionResponse {
  documentId: string
  caseId: string
  correlationId: string
  caseStatus: CaseStatus
  source: CaseSource
  documentType: DocumentType
  mimeType: string
  sha256: string
  sizeBytes: number
  job: { type: string; status: string }
  processing: 'pending'
  duplicateContent: boolean
}

export interface DocumentMeta {
  id: string
  caseId: string | null
  type: DocumentType
  source: CaseSource
  mimeType: string
  fileName: string | null
  sha256: string | null
  createdAt: IsoInstant
  updatedAt: IsoInstant
}

export interface ListDocumentsParams {
  page?: number
  pageSize?: number
  type?: DocumentType
  source?: CaseSource
  caseId?: string
}

// ---------------------------------------------------------------------------
// Asistente de texto — N1 (propuesto, implementado en esta rama)
// ---------------------------------------------------------------------------

export interface CreateTextIngestionInput {
  text: string
  requestId?: string
  caseType?: CaseType
  propertyId?: string
  obligationId?: string
  rentalId?: string
  contractId?: string
}

export interface TextIngestionResponse {
  caseId: string
  correlationId: string
  caseStatus: CaseStatus
  source: 'form'
  job: { type: 'text.interpret'; status: string }
  processing: 'pending'
  textLength: number
}
