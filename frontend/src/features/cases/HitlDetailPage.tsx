import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorBlock } from '../../components/StateBlocks'
import { LoadingButton, SkeletonCard } from '../../components/Feedback'
import { StatusBadge } from '../../components/StatusBadge'
import { useToast } from '../../components/Toasts'
import { ApiError } from '../../lib/api/errors'
import { friendlyError } from '../../lib/api/messages'
import { formatInstant, formatLongDate, formatPeriod } from '../../lib/format/dates'
import { formatMoney, formatMoneyWithCurrency } from '../../lib/format/money'
import { OBLIGATION_CATEGORY_LABELS, OBLIGATION_FREQUENCY_LABELS, label } from '../../lib/format/labels'
import { useObligation } from '../obligations/hooks'
import { useApplyProposal, useDecideHitl, useHitlRequest } from './hooks'
import { parseProposal, type KnownProposal } from './proposalSchema'
import { canApplyProposal, humanizeFieldKeys } from './reviewMode'
import { reviewStage } from './reviewState'
import { humanizeText, reviewHeading } from './reviewSummary'
import './review.css'

const COMMENT_MAX = 500

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="review-facts">
      {rows.map(([k, v]) => (
        <div key={k} className="review-fact">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function ScheduleDiff({ obligationId, changes }: { obligationId: string; changes: { dueDay?: number | null; reminderDaysBefore?: number; expectedAmount?: string | null } }) {
  const { data: obligation } = useObligation(obligationId)
  return (
    <div className="table-wrap">
      <table className="data-table" style={{ marginTop: '0.5rem' }}>
        <thead>
          <tr>
            <th>Dato</th>
            <th>Ahora</th>
            <th>Propuesto</th>
          </tr>
        </thead>
        <tbody>
          {changes.dueDay !== undefined && (
            <tr>
              <td>Día de vencimiento</td>
              <td>{obligation?.dueDay ?? '—'}</td>
              <td>{changes.dueDay ?? '—'}</td>
            </tr>
          )}
          {changes.reminderDaysBefore !== undefined && (
            <tr>
              <td>Aviso (días antes)</td>
              <td>{obligation?.reminderDaysBefore ?? '—'}</td>
              <td>{changes.reminderDaysBefore}</td>
            </tr>
          )}
          {changes.expectedAmount !== undefined && (
            <tr>
              <td>Monto base de cada período</td>
              <td>{formatMoney(obligation?.expectedAmount ?? null, obligation?.currency ?? 'COP')}</td>
              <td>{formatMoney(changes.expectedAmount ?? null, obligation?.currency ?? 'COP')}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * La obligación sobre la que actúa una propuesta (A-7), con sus datos reales: «Claro · Internet · $55.000».
 * Mientras carga (o si no se puede leer) usa el proveedor y concepto de la propuesta, si los trae.
 */
function SelectedObligation({ obligationId, fallback }: { obligationId: string; fallback?: { providerName: string; concept: string } }) {
  const { data } = useObligation(obligationId)
  const provider = data?.providerName ?? fallback?.providerName
  const concept = data?.concept ?? fallback?.concept
  const money = data?.expectedAmount ? formatMoney(data.expectedAmount, data.currency) : null
  const text = [provider, concept, money].filter(Boolean).join(' · ')
  return <strong>{text || 'Cargando…'}</strong>
}

/** Qué datos se registrarán, con importes y fechas en formato colombiano (nunca «87400.00» ni «2026-12-22»). */
function ProposalFacts({ proposal }: { proposal: KnownProposal }) {
  switch (proposal.action) {
    case 'create_obligation_with_occurrence': {
      const { obligation: o, occurrence: p } = proposal.data
      return (
        <>
          <Facts
            rows={[
              ['Proveedor', o.providerName],
              ['Concepto', o.concept],
              ['Categoría', label(OBLIGATION_CATEGORY_LABELS, o.category)],
              ['Importe', <strong key="m">{formatMoneyWithCurrency(p.amount ?? null, p.currency ?? o.currency ?? 'COP')}</strong>],
              ['Período facturado', formatPeriod(p.periodStart, p.periodEnd)],
              ['Fecha de vencimiento', formatLongDate(p.dueDate)],
            ]}
          />
          <p className="text-muted review-note">Se registra como un pago único: esta obligación no se repite sola.</p>
        </>
      )
    }
    case 'create_obligation_occurrence':
      return (
        <Facts
          rows={[
            ['Importe', <strong key="m">{formatMoneyWithCurrency(proposal.data.amount ?? null, proposal.data.currency ?? 'COP')}</strong>],
            ['Período facturado', formatPeriod(proposal.data.periodStart, proposal.data.periodEnd)],
            ['Fecha de vencimiento', formatLongDate(proposal.data.dueDate)],
          ]}
        />
      )
    case 'create_recurring_obligation': {
      const o = proposal.data.obligation
      return (
        <Facts
          rows={[
            ['Proveedor', o.providerName],
            ['Concepto', o.concept],
            ['Se repite', label(OBLIGATION_FREQUENCY_LABELS, o.frequency ?? 'monthly')],
            ['Vence', `el día ${o.dueDay} de cada ciclo`],
            ['Monto de cada período', o.expectedAmount ? <strong key="m">{formatMoneyWithCurrency(o.expectedAmount, o.currency ?? 'COP')}</strong> : 'Se completará al registrar cada período'],
            ...(o.reminderDaysBefore !== undefined ? ([['Aviso', `${o.reminderDaysBefore} día(s) antes`]] as Array<[string, ReactNode]>) : []),
          ]}
        />
      )
    }
    case 'archive_obligation':
      return (
        <>
          <Facts
            rows={[
              ['Obligación seleccionada', <SelectedObligation key="sel" obligationId={proposal.data.obligationId} fallback={proposal.data.expected} />],
              ['Proveedor', proposal.data.expected.providerName],
              ['Concepto', proposal.data.expected.concept],
            ]}
          />
          <ul className="review-note">
            <li>Dejará de generar períodos nuevos.</li>
            <li>Se conservan su historial, documentos y pagos.</li>
            <li>Los períodos pendientes no cambian y seguirás viéndolos hasta que los resuelvas.</li>
          </ul>
        </>
      )
    case 'update_obligation_schedule':
      return (
        <>
          <Facts rows={[['Obligación seleccionada', <SelectedObligation key="sel" obligationId={proposal.data.obligationId} />]]} />
          <ScheduleDiff obligationId={proposal.data.obligationId} changes={proposal.data.changes} />
        </>
      )
    case 'update_occurrence_details':
      return (
        <Facts
          rows={[
            ...(proposal.data.amount ? ([['Importe', <strong key="m">{formatMoneyWithCurrency(proposal.data.amount, 'COP')}</strong>]] as Array<[string, ReactNode]>) : []),
            ...(proposal.data.dueDate ? ([['Fecha de vencimiento', formatLongDate(proposal.data.dueDate)]] as Array<[string, ReactNode]>) : []),
          ]}
        />
      )
    case 'create_recurring_rental': {
      const r = proposal.data.rental
      return (
        <Facts
          rows={[
            ['Canon mensual', <strong key="m">{formatMoneyWithCurrency(r.expectedAmount, r.currency ?? 'COP')}</strong>],
            ['Día de cobro', `el día ${r.dueDay} de cada ciclo`],
            ['Inicia', formatLongDate(r.startsOn)],
            ...(r.tenantAlias ? ([['Inquilino', r.tenantAlias]] as Array<[string, ReactNode]>) : []),
          ]}
        />
      )
    }
  }
}

export function HitlDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: hitl, isLoading, isError, error, refetch } = useHitlRequest(id)
  const decide = useDecideHitl(id!)
  const apply = useApplyProposal()
  const toast = useToast()
  const navigate = useNavigate()
  const [choice, setChoice] = useState<string>('')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [decideError, setDecideError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applied, setApplied] = useState<{ already: boolean; obligationId: string | null } | null>(null)

  if (isLoading) return <SkeletonCard lines={6} label="Cargando revisión…" />
  if (isError || !hitl) return <ErrorBlock error={error} onRetry={refetch} />

  const choices = hitl.options.choices ?? []
  const proposal = hitl.proposal
  const parsed = proposal ? parseProposal(proposal.proposedData) : null
  const info = reviewStage(hitl, parsed, applied !== null)
  const heading = reviewHeading(hitl, parsed)
  const canApply = canApplyProposal(hitl, parsed) && info.stage !== 'applied'
  const context = hitl.options.context ?? {}
  const hasConsequences = typeof context.consecuencias === 'string' && /aprobar solo confirma/i.test(context.consecuencias)
  const pending = info.stage === 'pending'
  const overdue = info.stage === 'expired' && hitl.status === 'pending'

  async function handleDecision(decision: 'approved' | 'rejected') {
    setDecideError(null)
    if (decision === 'approved' && choices.length > 0 && !choice) {
      setDecideError('Elige una alternativa antes de continuar.')
      return
    }
    const text = (decision === 'approved' ? note : reason).trim()
    try {
      const updated = await decide.mutateAsync({
        decision,
        choice: decision === 'approved' && choices.length > 0 ? choice : undefined,
        comment: text || undefined,
      })
      setRejecting(false)
      const followUp = updated.decision?.followUpRequestId
      if (decision === 'approved' && followUp) {
        // A-7: elegir no cambia nada; el backend ya preparó la propuesta concreta para revisarla.
        toast.success('Elección registrada. Revisa ahora la propuesta para aprobarla y aplicarla.')
        navigate(`/revisiones/${followUp}`)
        return
      }
      if (decision === 'rejected') toast.success('Rechazaste la propuesta. No se registró nada.')
      else if (info.mode === 'applicable') toast.success('Propuesta aprobada. Falta aplicarla para registrar el cambio.')
      else toast.success('Listo, quedó registrada tu decisión.')
    } catch (err) {
      setDecideError(friendlyError(err, 'decide'))
      // Si la revisión ya se resolvió (otra pestaña o dispositivo), se trae el estado real.
      if (err instanceof ApiError && (err.status === 409 || err.status === 400)) void refetch()
    }
  }

  async function handleApply() {
    if (!proposal || !hitl) return
    setApplyError(null)
    try {
      const res = await apply.mutateAsync({ caseId: hitl.caseId, proposalId: proposal.id })
      const obligationId = res.createdObligationId ?? res.resource?.obligationId ?? (res.resource?.type === 'obligation' ? res.resource.id : null)
      setApplied({ already: res.alreadyApplied, obligationId })
      toast.success(res.alreadyApplied ? 'Esta propuesta ya estaba aplicada.' : 'Cambio aplicado: ya aparece en tus datos.')
    } catch (err) {
      setApplyError(friendlyError(err, 'apply'))
      if (err instanceof ApiError && err.status === 409) void refetch()
    }
  }

  const decisionComment = hitl.decision?.comment?.trim()
  const rejectedStage = info.stage === 'rejected'
  const continues = typeof (context as { continuation?: unknown }).continuation === 'object' && (context as { continuation?: unknown }).continuation !== null
  const followUpId = hitl.decision?.followUpRequestId

  return (
    <div className="stack">
      <Link to={`/casos/${hitl.caseId}`}>← Volver a la solicitud</Link>
      <div className="card review-card">
        <div className="row-between review-head">
          <h1 style={{ margin: 0 }}>{heading.title}</h1>
          <StatusBadge label={info.badge} tone={info.tone} />
        </div>
        {pending && <p className="text-muted">Sugerencia de IA — requiere tu confirmación antes de registrar nada.</p>}
        {heading.description !== heading.title && <p>{heading.description}</p>}

        {parsed?.kind === 'known' && <ProposalFacts proposal={parsed.value} />}
        {parsed?.kind === 'known' && parsed.value.action === 'update_occurrence_details' && (
          <p className="text-muted review-note">Solo afecta un período pendiente; no confirma ningún pago.</p>
        )}
        {parsed?.kind === 'known' && parsed.value.action === 'create_recurring_rental' && (
          <p className="text-muted review-note">Se generarán cobros esperados; no se cobra ni se envía ningún mensaje.</p>
        )}

        {pending && <ContextNotes context={context} />}

        {parsed?.kind === 'guided' && (
          <p className="text-muted">Esta solicitud se completa manualmente; no tiene un botón «Aplicar».</p>
        )}
        {parsed?.kind === 'transcript' && (
          <div>
            <p className="text-muted">Esto es lo que entendimos de tu nota de voz:</p>
            <p>«{parsed.value.transcript}»</p>
          </div>
        )}
        {parsed?.kind === 'unknown' && isManualOnly(parsed.raw) && !(continues && choices.length > 0) && (
          <p className="text-muted">Esta solicitud no tiene una acción que aplicar: complétala manualmente desde el formulario correspondiente.</p>
        )}
        {parsed?.kind === 'unknown' && !isManualOnly(parsed.raw) && (
          <p className="field-error">No pudimos interpretar esta propuesta. Revísala manualmente o recházala; no se registrará nada por sí sola.</p>
        )}

        {hitl.status === 'pending' && <p className="text-muted">Plazo para decidir: {formatInstant(hitl.dueAt)}</p>}
        {overdue && <p className="field-error">El plazo terminó. Una revisión vencida nunca se aprueba sola.</p>}

        {choices.length > 0 && pending && (
          <fieldset className="review-choices">
            <legend>
              {continues
                ? 'Elige a cuál te refieres. Elegir no cambia nada todavía: a continuación verás la propuesta concreta para aprobarla y aplicarla.'
                : 'Elige a cuál te refieres. Tu elección queda registrada, pero no ejecuta ningún cambio: después edita el recurso manualmente.'}
            </legend>
            {choices.map((c) => (
              <label key={c.key} className="row" style={{ marginBottom: '0.3rem' }}>
                <input type="radio" name="choice" value={c.key} checked={choice === c.key} onChange={() => setChoice(c.key)} />
                {c.label}
              </label>
            ))}
          </fieldset>
        )}

        {/* ---------------- Decisión ---------------- */}
        {pending && (
          <div className="stack review-decision" aria-busy={decide.isPending || undefined}>
            {!rejecting ? (
              <>
                <details className="review-note-box">
                  <summary>Agregar una nota (opcional)</summary>
                  <div className="field">
                    <label htmlFor="approve-note">Nota para tu registro</label>
                    <textarea id="approve-note" rows={2} maxLength={COMMENT_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
                    <span className="text-muted review-help">Se guarda con tu decisión y podrás verla después en esta revisión. {note.length}/{COMMENT_MAX}</span>
                  </div>
                </details>
                {decideError && <p className="field-error" role="alert">{decideError}</p>}
                <p className="text-muted review-help">
                  {info.mode === 'applicable'
                    ? hasConsequences
                      ? 'Tu decisión queda registrada.'
                      : 'Aprobar solo confirma que los datos son correctos: todavía no se crea nada. Después podrás aplicar el cambio. Tu decisión queda registrada.'
                    : 'Tu decisión queda registrada y no se puede cambiar después.'}
                </p>
                <div className="row">
                  <LoadingButton className="btn btn-primary" loading={decide.isPending} loadingText="Guardando decisión…" onClick={() => void handleDecision('approved')}>
                    {info.mode === 'applicable' ? 'Aprobar propuesta' : info.mode === 'choice' ? (continues ? 'Continuar con la seleccionada' : 'Confirmar mi elección') : 'Entendido'}
                  </LoadingButton>
                  <button type="button" className="btn btn-secondary" disabled={decide.isPending} onClick={() => { setRejecting(true); setDecideError(null) }}>
                    Rechazar…
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="reject-reason">Motivo del rechazo (opcional)</label>
                  <textarea id="reject-reason" rows={2} maxLength={COMMENT_MAX} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                  <span className="text-muted review-help">Cuenta por qué no es correcto: queda guardado en esta revisión. {reason.length}/{COMMENT_MAX}</span>
                </div>
                {decideError && <p className="field-error" role="alert">{decideError}</p>}
                <p className="text-muted review-help">Al rechazar no se registra nada y no se puede deshacer.</p>
                <div className="row">
                  <LoadingButton className="btn btn-danger" loading={decide.isPending} loadingText="Rechazando…" onClick={() => void handleDecision('rejected')}>
                    Confirmar rechazo
                  </LoadingButton>
                  <button type="button" className="btn btn-secondary" disabled={decide.isPending} onClick={() => setRejecting(false)}>
                    Volver
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------------- Estado tras decidir ---------------- */}
        {info.stage === 'approved_pending_apply' && (
          <p role="status" className="review-status">Aprobaste esta propuesta, pero aún no se creó nada. Pulsa «Aplicar propuesta» para registrar el cambio.</p>
        )}
        {info.stage === 'approved_apply_unknown' && !applied && (
          <p role="status" className="review-status">
            Aprobaste esta propuesta. Si todavía no la aplicaste, pulsa «Aplicar propuesta» para registrar el cambio; si ya estaba aplicada, el sistema te lo dirá y no duplicará nada.
          </p>
        )}
        {info.stage === 'acknowledged' && (
          <p role="status" className="review-status">Listo, quedó registrado que lo viste. No se creó ni se cambió ningún dato.</p>
        )}
        {info.stage === 'choice_recorded' && followUpId && (
          <p role="status" className="review-status">
            Elección registrada. Todavía no se cambió nada: <Link to={`/revisiones/${followUpId}`}>revisa la propuesta para aprobarla y aplicarla</Link>.
          </p>
        )}
        {info.stage === 'choice_recorded' && !followUpId && (
          <p role="status" className="review-status">Elección registrada. No hay nada que aplicar automáticamente: no se creó ni se cambió ningún dato. Debes registrarlo manualmente desde el formulario correspondiente.</p>
        )}
        {rejectedStage && <p role="status" className="review-status">Rechazaste esta propuesta: no se registró nada.</p>}
        {hitl.status === 'expired' && <p role="status" className="review-status">Venció sin decisión: no se aplicará nada.</p>}
        {hitl.status === 'cancelled' && <p role="status" className="review-status">Esta revisión fue anulada: no se aplicará nada.</p>}

        {canApply && !applied && (
          <div className="stack review-apply">
            <p className="text-muted review-help">Al aplicar se registrará el cambio en tus datos. No se puede deshacer desde esta pantalla (podrás editar o archivar lo creado desde su módulo).</p>
            {applyError && <p className="field-error" role="alert">{applyError}</p>}
            <div className="row">
              <LoadingButton className="btn btn-primary" loading={apply.isPending} loadingText="Aplicando…" onClick={() => void handleApply()}>
                Aplicar propuesta
              </LoadingButton>
            </div>
          </div>
        )}

        {info.stage === 'applied' && (
          <div role="status" className="review-status review-done">
            <p style={{ margin: 0 }}>
              <strong>{applied?.already ? 'Esta propuesta ya estaba aplicada.' : 'Propuesta aplicada.'}</strong> El cambio ya está registrado en tus datos.
            </p>
            {applied?.obligationId && (
              <p style={{ margin: '0.4rem 0 0' }}>
                <Link to={`/obligaciones/${applied.obligationId}`}>Ver la obligación</Link>
              </p>
            )}
          </div>
        )}
        {applyError && !canApply && <p className="field-error" role="alert">{applyError}</p>}

        {/* ---------------- Lo que decidiste ---------------- */}
        {hitl.decision && hitl.respondedAt && (
          <div className="review-record">
            <p className="text-muted" style={{ margin: 0 }}>
              {decisionRecord(hitl.decision.outcome, info.stage)} · {formatInstant(hitl.respondedAt)}
            </p>
            {decisionComment && (
              <blockquote className="review-quote">
                <span className="review-quote-label">{hitl.decision.outcome === 'rejected' ? 'Motivo del rechazo' : 'Tu nota'}</span>
                {decisionComment}
              </blockquote>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Línea de registro de la decisión. «Entendido» se envía como `approved` (misma transición de servidor), pero la
 * persona no aprobó nada: solo vio la información; y elegir una alternativa tampoco es aprobar una propuesta.
 */
function decisionRecord(outcome: string | undefined, stage: string): string {
  if (outcome === 'rejected') return 'Rechazaste esta revisión'
  if (stage === 'acknowledged') return 'Marcaste esta revisión como entendida'
  if (stage === 'choice_recorded') return 'Registraste tu elección'
  return 'Aprobaste esta revisión'
}

/** Propuesta sin acción aplicable que el flujo marcó para completar a mano (faltan datos, informativa, no soportada). */
function isManualOnly(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { requiereRevisionManual?: unknown }).requiereRevisionManual === true
}

const CONTEXT_LABELS: Record<string, string> = {
  advertencias: 'Advertencias',
  consecuencias: 'Qué pasaría',
  documentoDuplicado: 'Posible duplicado',
}

/** Muestra solo textos (o listas de textos) conocidos del contexto; nunca vuelca JSON técnico. */
function ContextNotes({ context }: { context: Record<string, unknown> }) {
  const rows = Object.entries(CONTEXT_LABELS).flatMap(([key, title]) => {
    const v = context[key]
    const items = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return items.length ? [{ key, title, items }] : []
  })
  if (rows.length === 0) return null
  return (
    <div style={{ margin: '0.5rem 0' }}>
      {rows.map((r) => (
        <div key={r.key}>
          <strong>{r.title}</strong>
          <ul>
            {r.items.map((t, i) => (
              <li key={i}>{humanizeText(humanizeFieldKeys(t))}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
