import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { formatInstant } from '../../lib/format/dates'
import { CASE_STATUS_LABELS, CASE_TYPE_LABELS, PROPOSAL_REVIEW_STATUS_LABELS, SOURCE_LABELS, label } from '../../lib/format/labels'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import { useCase, useCaseHitl, useProposals } from './hooks'

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

  if (isLoading) return <LoadingBlock label="Cargando caso…" />
  if (isError || !caseRow) return <ErrorBlock error={error} onRetry={refetch} />

  const pendingHitl = hitl?.items.find((h) => h.status === 'pending')

  return (
    <div className="stack">
      <Link to="/casos">← Volver a mis solicitudes</Link>
      <div className="card row-between">
        <div>
          <h1 style={{ margin: 0 }}>{label(CASE_TYPE_LABELS, caseRow.type)}</h1>
          <p className="text-muted" style={{ margin: 0 }}>
            Origen: {label(SOURCE_LABELS, caseRow.source)} · Creado {formatInstant(caseRow.createdAt)}
          </p>
        </div>
        <StatusBadge label={label(CASE_STATUS_LABELS, caseRow.status)} tone={toneFor.case(caseRow.status)} />
      </div>

      {caseRow.status === 'received' && (
        <p className="text-muted">En cola. Se procesará cuando la automatización esté disponible.</p>
      )}
      {caseRow.status === 'failed' && caseRow.statusReason && (
        <p className="field-error">Motivo: {caseRow.statusReason}</p>
      )}
      {pendingHitl && (
        <div className="card">
          <p>Tienes una revisión pendiente para este caso.</p>
          <Link to={`/revisiones/${pendingHitl.id}`} className="btn btn-primary">
            Revisar
          </Link>
        </div>
      )}

      <div className="card">
        <h2 className="card-title">Propuestas</h2>
        {!proposals || proposals.items.length === 0 ? (
          <p className="text-muted">Todavía no hay propuestas para este caso.</p>
        ) : (
          <ul>
            {proposals.items.map((p) => (
              <li key={p.id}>
                Versión {p.version} · {label(PROPOSAL_REVIEW_STATUS_LABELS, p.reviewStatus)} ·{' '}
                <span className="text-muted">Sugerencia de IA — requiere tu confirmación</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
