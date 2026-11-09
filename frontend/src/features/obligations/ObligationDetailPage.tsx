import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { formatCalendarDate, describeDueDate } from '../../lib/format/dates'
import { formatMoney } from '../../lib/format/money'
import { OBLIGATION_CATEGORY_LABELS, OBLIGATION_STATUS_LABELS, OCCURRENCE_STATUS_LABELS, label } from '../../lib/format/labels'
import { useObligation, useOccurrences } from './hooks'
import { ObligationFormModal } from './ObligationFormModal'
import { OccurrenceFormModal } from './OccurrenceFormModal'
import { ConfirmOccurrenceModal } from './ConfirmOccurrenceModal'
import type { ObligationOccurrence } from '../../lib/api/types'

const OPEN_STATUSES = new Set(['pending', 'overdue'])

export function ObligationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: obligation, isLoading, isError, error, refetch } = useObligation(id)
  const { data: occurrences, isLoading: loadingOcc } = useOccurrences(id)
  const [editing, setEditing] = useState(false)
  const [creatingOcc, setCreatingOcc] = useState(false)
  const [editingOcc, setEditingOcc] = useState<ObligationOccurrence | null>(null)
  const [confirming, setConfirming] = useState<ObligationOccurrence | null>(null)

  if (isLoading) return <LoadingBlock label="Cargando obligación…" />
  if (isError || !obligation) return <ErrorBlock error={error} onRetry={refetch} />

  return (
    <div className="stack">
      <Link to="/obligaciones">← Volver a obligaciones</Link>
      <div className="card row-between">
        <div>
          <h1 style={{ margin: 0 }}>{obligation.providerName}</h1>
          <p className="text-muted" style={{ margin: 0 }}>
            {obligation.concept} · {label(OBLIGATION_CATEGORY_LABELS, obligation.category)}
          </p>
        </div>
        <StatusBadge label={label(OBLIGATION_STATUS_LABELS, obligation.status)} tone={toneFor.obligation(obligation.status)} />
      </div>

      <div className="card">
        <div className="row-between">
          <h2 className="card-title">Datos de la obligación</h2>
          {obligation.status !== 'archived' && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
              Editar
            </button>
          )}
        </div>
        <div className="form-grid">
          <p>
            <strong>Monto esperado:</strong> {formatMoney(obligation.expectedAmount, obligation.currency)}
          </p>
          <p>
            <strong>Día de vencimiento:</strong> {obligation.dueDay ?? '—'}
          </p>
          <p>
            <strong>Aviso:</strong> {obligation.reminderDaysBefore} día(s) antes
          </p>
          <p>
            <strong>Generación automática:</strong> {obligation.autoGenerate ? 'Activa' : 'Inactiva'}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="row-between">
          <h2 className="card-title">Períodos</h2>
          {obligation.status !== 'archived' && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreatingOcc(true)}>
              Nuevo período
            </button>
          )}
        </div>

        {loadingOcc && <LoadingBlock label="Cargando períodos…" />}
        {!loadingOcc && occurrences && occurrences.items.length === 0 && (
          <EmptyBlock title="Esta obligación aún no tiene períodos" />
        )}
        {!loadingOcc && occurrences && occurrences.items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Período</th>
                  <th>Vence</th>
                  <th>Monto</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {occurrences.items.map((occ) => {
                  const effectiveOverdue = OPEN_STATUSES.has(occ.status) && describeDueDate(occ.dueDate).startsWith('Vencido')
                  return (
                    <tr key={occ.id}>
                      <td>
                        {formatCalendarDate(occ.periodStart)} – {formatCalendarDate(occ.periodEnd)}
                      </td>
                      <td>
                        {formatCalendarDate(occ.dueDate)}
                        {OPEN_STATUSES.has(occ.status) && (
                          <div className="text-muted">{describeDueDate(occ.dueDate)}</div>
                        )}
                      </td>
                      <td>{formatMoney(occ.amount, occ.currency)}</td>
                      <td>
                        <StatusBadge
                          label={label(OCCURRENCE_STATUS_LABELS, effectiveOverdue ? 'overdue' : occ.status)}
                          tone={toneFor.occurrence(effectiveOverdue ? 'overdue' : occ.status)}
                        />
                      </td>
                      <td className="row">
                        {OPEN_STATUSES.has(occ.status) && (
                          <>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingOcc(occ)}>
                              Editar
                            </button>
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirming(occ)}>
                              Confirmar
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <ObligationFormModal obligation={obligation} onClose={() => setEditing(false)} />}
      {creatingOcc && <OccurrenceFormModal obligationId={obligation.id} onClose={() => setCreatingOcc(false)} />}
      {editingOcc && (
        <OccurrenceFormModal obligationId={obligation.id} occurrence={editingOcc} onClose={() => setEditingOcc(null)} />
      )}
      {confirming && (
        <ConfirmOccurrenceModal obligationId={obligation.id} occurrence={confirming} onClose={() => setConfirming(null)} />
      )}
    </div>
  )
}
