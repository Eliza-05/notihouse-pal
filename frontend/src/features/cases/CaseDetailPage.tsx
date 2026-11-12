import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ErrorBlock } from '../../components/StateBlocks'
import { SkeletonCard, Spinner } from '../../components/Feedback'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { formatInstant } from '../../lib/format/dates'
import { CASE_STATUS_LABELS, PROPOSAL_REVIEW_STATUS_LABELS, SOURCE_LABELS, label } from '../../lib/format/labels'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import { caseProgress, type StepState } from './caseProgress'
import { caseTitle, proposalAction } from './caseTitle'
import { useCase, useCaseHitl, useProposals } from './hooks'
import { parseProposal } from './proposalSchema'
import { reviewHeading } from './reviewSummary'
import './review.css'

const STEP_MARK: Record<StepState, string> = { done: '✓', active: '•', waiting: '', skipped: '–', failed: '!' }
const STEP_STATE_LABEL: Record<StepState, string> = {
  done: 'Listo',
  active: 'En curso',
  waiting: 'Pendiente',
  skipped: 'No aplica',
  failed: 'Con problema',
}

export function CaseDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: caseRow, isLoading, isError, error, refetch } = useCase(id)
  const { data: proposals } = useProposals(id)
  const { data: hitl } = useCaseHitl(id, caseRow?.status)
  const qc = useQueryClient()
  const { user } = useAuth()

  // Cuando el estado del caso cambia (p. ej. processing → awaiting_human) se
  // vuelven a pedir revisión y propuestas, para que la pantalla sea coherente
  // con el nuevo estado sin recargar la página.
  const lastStatus = useRef<string | undefined>(undefined)
  const status = caseRow?.status
  useEffect(() => {
    if (!status || !id) return
    if (lastStatus.current !== undefined && lastStatus.current !== status) {
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'hitl') })
      qc.invalidateQueries({ queryKey: queryKey(user!.id, 'proposals', id) })
    }
    lastStatus.current = status
  }, [status, id, qc, user])

  if (isLoading) return <SkeletonCard lines={5} label="Cargando solicitud…" />
  if (isError || !caseRow) return <ErrorBlock error={error} onRetry={refetch} />

  const pendingHitl = hitl?.items.find((h) => h.status === 'pending')
  const progress = caseProgress({ caseRow, hitl: hitl?.items, proposals: proposals?.items })

  return (
    <div className="stack">
      <Link to="/casos">← Volver a mis solicitudes</Link>
      <div className="card row-between">
        <div>
          <h1 style={{ margin: 0 }}>{caseTitle(caseRow, proposalAction(proposals?.items))}</h1>
          <p className="text-muted" style={{ margin: 0 }}>
            Origen: {label(SOURCE_LABELS, caseRow.source)} · Recibida {formatInstant(caseRow.createdAt)}
          </p>
        </div>
        <StatusBadge label={progress.headline} tone={progress.tone === 'success' ? 'success' : progress.tone === 'danger' ? 'danger' : progress.tone === 'warning' ? 'warning' : progress.tone === 'info' ? 'info' : toneFor.case(caseRow.status)} />
      </div>

      <div className="card" aria-busy={progress.busy || undefined}>
        <h2 className="card-title">Cómo va tu solicitud</h2>
        <p className="row" style={{ margin: 0, alignItems: 'center', gap: '0.5rem' }} role="status">
          {progress.busy && <Spinner size={16} />}
          <strong>{progress.headline}</strong>
        </p>
        {progress.slowNote && <p className="text-muted">{progress.slowNote}</p>}
        <ol className="progress-steps">
          {progress.steps.map((step) => (
            <li key={step.key} className={`progress-step is-${step.state}`}>
              <span className="progress-dot" aria-hidden="true">{STEP_MARK[step.state]}</span>
              <div>
                <p className="progress-title">
                  {step.title} <span className="visually-hidden">— {STEP_STATE_LABEL[step.state]}</span>
                </p>
                <p className="progress-text">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-muted review-help" style={{ marginTop: '0.75rem' }}>
          Estado del sistema: {label(CASE_STATUS_LABELS, caseRow.status)}. «Cerrado» indica que el proceso terminó; si había una propuesta, revisa arriba si se aplicó.
        </p>
      </div>

      {caseRow.status === 'failed' && (
        <div className="card" role="status">
          <p style={{ marginTop: 0 }}>
            No se registró nada a partir de esta solicitud, así que puedes enviarla de nuevo sin riesgo de duplicar datos.
          </p>
          <Link to={caseRow.source === 'document' || caseRow.source === 'gmail' ? '/documentos' : '/asistente'} className="btn btn-secondary">
            {caseRow.source === 'document' || caseRow.source === 'gmail' ? 'Subir otra factura' : 'Volver a intentarlo'}
          </Link>
        </div>
      )}

      {pendingHitl && (
        <div className="card">
          <p style={{ marginTop: 0 }}>Tienes una revisión pendiente para esta solicitud.</p>
          <Link to={`/revisiones/${pendingHitl.id}`} className="btn btn-primary">
            Revisar propuesta
          </Link>
        </div>
      )}

      <div className="card">
        <h2 className="card-title">Propuestas</h2>
        {!proposals || proposals.items.length === 0 ? (
          <p className="text-muted">Todavía no hay propuestas para esta solicitud.</p>
        ) : (
          <ul className="review-proposals">
            {proposals.items.map((p) => {
              const heading = reviewHeading({ decisionType: 'data_confirmation', options: {}, proposal: p }, parseProposal(p.proposedData))
              const applied = typeof p.appliedAt === 'string' && p.appliedAt
              return (
                <li key={p.id}>
                  <strong>{heading.title}</strong>
                  <br />
                  <span className="text-muted">
                    {label(PROPOSAL_REVIEW_STATUS_LABELS, p.reviewStatus)}
                    {applied ? ' · Aplicada' : p.appliedAt === null && p.reviewStatus === 'accepted' ? ' · Falta aplicar' : ''} · Sugerencia de IA
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
