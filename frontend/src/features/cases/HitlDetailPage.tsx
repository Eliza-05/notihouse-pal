import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { ApiError } from '../../lib/api/errors'
import { formatInstant, formatCalendarDate } from '../../lib/format/dates'
import { formatMoney } from '../../lib/format/money'
import { HITL_DECISION_TYPE_LABELS, label } from '../../lib/format/labels'
import { useObligation } from '../obligations/hooks'
import { useApplyProposal, useDecideHitl, useHitlRequest } from './hooks'
import { parseProposal } from './proposalSchema'

const APPLICABLE_ACTIONS = new Set([
  'create_obligation_occurrence',
  'create_obligation_with_occurrence',
  'create_recurring_obligation',
  'update_obligation_schedule',
  'update_occurrence_details',
  'create_recurring_rental',
])

function ScheduleDiff({ obligationId, expected }: { obligationId: string; expected: { dueDay?: number | null; reminderDaysBefore?: number; expectedAmount?: string | null } }) {
  const { data: obligation } = useObligation(obligationId)
  return (
    <table className="data-table" style={{ marginTop: '0.5rem' }}>
      <thead>
        <tr>
          <th>Campo</th>
          <th>Actual</th>
          <th>Propuesto</th>
        </tr>
      </thead>
      <tbody>
        {expected.dueDay !== undefined && (
          <tr>
            <td>Día de vencimiento</td>
            <td>{obligation?.dueDay ?? '—'}</td>
            <td>{expected.dueDay ?? '—'}</td>
          </tr>
        )}
        {expected.reminderDaysBefore !== undefined && (
          <tr>
            <td>Aviso (días antes)</td>
            <td>{obligation?.reminderDaysBefore ?? '—'}</td>
            <td>{expected.reminderDaysBefore}</td>
          </tr>
        )}
        {expected.expectedAmount !== undefined && (
          <tr>
            <td>Monto esperado</td>
            <td>{formatMoney(obligation?.expectedAmount ?? null, obligation?.currency ?? 'COP')}</td>
            <td>{formatMoney(expected.expectedAmount ?? null, obligation?.currency ?? 'COP')}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

export function HitlDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: hitl, isLoading, isError, error, refetch } = useHitlRequest(id)
  const decide = useDecideHitl(id!)
  const apply = useApplyProposal()
  const [choice, setChoice] = useState<string>('')
  const [comment, setComment] = useState('')
  const [decideError, setDecideError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<string | null>(null)

  if (isLoading) return <LoadingBlock label="Cargando revisión…" />
  if (isError || !hitl) return <ErrorBlock error={error} onRetry={refetch} />

  const choices = hitl.options.choices ?? []
  const overdue = hitl.overdue || hitl.status === 'expired'
  const proposal = hitl.proposal
  const parsed = proposal ? parseProposal(proposal.proposedData) : null

  async function handleDecision(decision: 'approved' | 'rejected') {
    setDecideError(null)
    if (decision === 'approved' && choices.length > 0 && !choice) {
      setDecideError('Elige una alternativa antes de aprobar.')
      return
    }
    try {
      await decide.mutateAsync({ decision, choice: decision === 'approved' && choices.length > 0 ? choice : undefined, comment: comment || undefined })
    } catch (err) {
      setDecideError(err instanceof ApiError ? err.messages.join(' ') : 'No se pudo registrar la decisión.')
    }
  }

  async function handleApply() {
    if (!proposal || !hitl) return
    setApplyError(null)
    try {
      const res = await apply.mutateAsync({ caseId: hitl.caseId, proposalId: proposal.id })
      setApplyResult(res.alreadyApplied ? 'Esta propuesta ya estaba aplicada.' : 'Cambio aplicado correctamente.')
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.messages.join(' ') : 'No se pudo aplicar la propuesta.')
    }
  }

  const canApply =
    hitl.status === 'approved' &&
    !!proposal &&
    proposal.reviewStatus === 'accepted' &&
    proposal.source !== 'stt' &&
    choices.length === 0 &&
    hitl.decisionType === 'data_confirmation' &&
    parsed?.kind === 'known' &&
    APPLICABLE_ACTIONS.has(parsed.value.action)

  return (
    <div className="stack">
      <Link to={`/casos/${hitl.caseId}`}>← Volver al caso</Link>
      <div className="card">
        <h1 style={{ marginTop: 0 }}>{label(HITL_DECISION_TYPE_LABELS, hitl.decisionType)}</h1>
        <p className="text-muted">Sugerencia de IA — requiere tu confirmación</p>
        {hitl.options.summary && <p>{hitl.options.summary}</p>}
        <p className="text-muted">Plazo: {formatInstant(hitl.dueAt)}</p>

        {overdue && (
          <p className="field-error">El plazo terminó. Una revisión vencida nunca se aprueba sola.</p>
        )}

        {parsed?.kind === 'known' && parsed.value.action === 'update_obligation_schedule' && (
          <ScheduleDiff obligationId={parsed.value.data.obligationId} expected={parsed.value.data.expected} />
        )}

        {parsed?.kind === 'known' && parsed.value.action === 'create_recurring_obligation' && (
          <p>
            Obligación <strong>{parsed.value.data.obligation.providerName}</strong>, vence día{' '}
            {parsed.value.data.obligation.dueDay} de cada mes. Se generará el período de cada ciclo.
          </p>
        )}

        {parsed?.kind === 'known' && parsed.value.action === 'create_recurring_rental' && (
          <p>
            Arriendo por {formatMoney(parsed.value.data.rental.expectedAmount, 'COP')}, día de cobro{' '}
            {parsed.value.data.rental.dueDay}. Se generarán cobros esperados; no se cobra ni se envía ningún mensaje.
          </p>
        )}

        {parsed?.kind === 'known' &&
          (parsed.value.action === 'create_obligation_occurrence' || parsed.value.action === 'create_obligation_with_occurrence') && (
            <p>
              Período con vencimiento {formatCalendarDate('dueDate' in parsed.value.data ? parsed.value.data.dueDate : parsed.value.data.occurrence.dueDate)}.
            </p>
          )}

        {parsed?.kind === 'guided' && (
          <p className="text-muted">Esta solicitud se completa manualmente; no tiene un botón "Aplicar".</p>
        )}

        {parsed?.kind === 'transcript' && (
          <div>
            <p className="text-muted">Transcripción:</p>
            <p>{parsed.value.transcript}</p>
          </div>
        )}

        {parsed?.kind === 'unknown' && (
          <div>
            <p className="field-error">Requiere revisión manual: no se reconoció la forma de esta propuesta.</p>
            <pre style={{ fontSize: '0.75rem', overflowX: 'auto' }}>{JSON.stringify(parsed.raw, null, 2)}</pre>
          </div>
        )}

        {choices.length > 0 && hitl.status === 'pending' && !overdue && (
          <fieldset style={{ marginTop: '0.75rem' }}>
            <legend>Elige a cuál te refieres. Aún no se cambia nada.</legend>
            {choices.map((c) => (
              <label key={c.key} className="row" style={{ marginBottom: '0.3rem' }}>
                <input type="radio" name="choice" value={c.key} checked={choice === c.key} onChange={() => setChoice(c.key)} />
                {c.label}
              </label>
            ))}
          </fieldset>
        )}

        {hitl.status === 'pending' && !overdue && (
          <div className="stack" style={{ marginTop: '0.75rem' }}>
            <div className="field">
              <label htmlFor="comment">Comentario (opcional)</label>
              <textarea id="comment" rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
            </div>
            {decideError && <p className="field-error" role="alert">{decideError}</p>}
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={decide.isPending} onClick={() => handleDecision('approved')}>
                Aprobar
              </button>
              <button type="button" className="btn btn-secondary" disabled={decide.isPending} onClick={() => handleDecision('rejected')}>
                Rechazar
              </button>
            </div>
          </div>
        )}

        {hitl.status === 'approved' && (
          <p role="status">Aprobada. Aún no se ha creado nada: pulsa Aplicar para registrar el cambio.</p>
        )}
        {hitl.status === 'rejected' && <p role="status">Rechazada: no se registró nada.</p>}
        {hitl.status === 'expired' && <p role="status">Vencida sin decisión: no se aplicará nada.</p>}

        {canApply && (
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <button type="button" className="btn btn-primary" disabled={apply.isPending} onClick={handleApply}>
              {apply.isPending ? 'Aplicando…' : 'Aplicar'}
            </button>
          </div>
        )}
        {hitl.status === 'approved' && !canApply && parsed?.kind !== 'guided' && (
          <p className="text-muted">Debes registrarlo manualmente desde el formulario correspondiente.</p>
        )}
        {applyError && <p className="field-error" role="alert">{applyError}</p>}
        {applyResult && <p role="status">{applyResult}</p>}
      </div>
    </div>
  )
}
