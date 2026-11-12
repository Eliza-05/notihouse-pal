import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { SkeletonCard } from '../../components/Feedback'
import { SkeletonTable } from '../../components/Feedback'
import { EmptyBlock, ErrorBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { formatCalendarDate, describeDueDate } from '../../lib/format/dates'
import { formatMoney } from '../../lib/format/money'
import { CHARGE_STATUS_LABELS, RENTAL_STATUS_LABELS, label } from '../../lib/format/labels'
import { useProperty } from '../properties/hooks'
import { useCharges, useRental } from './hooks'
import { RentalFormModal } from './RentalFormModal'
import { ChargeFormModal } from './ChargeFormModal'
import { ConfirmChargeModal } from './ConfirmChargeModal'
import type { RentCharge } from '../../lib/api/types'

const OPEN_STATUSES = new Set(['expected', 'pending', 'overdue'])

export function RentalDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: rental, isLoading, isError, error, refetch } = useRental(id)
  const { data: property } = useProperty(rental?.propertyId)
  const { data: charges, isLoading: loadingCharges } = useCharges(id)
  const [editing, setEditing] = useState(false)
  const [creatingCharge, setCreatingCharge] = useState(false)
  const [editingCharge, setEditingCharge] = useState<RentCharge | null>(null)
  const [confirming, setConfirming] = useState<RentCharge | null>(null)

  if (isLoading) return <SkeletonCard lines={4} label="Cargando arriendo…" />
  if (isError || !rental) return <ErrorBlock error={error} onRetry={refetch} />

  return (
    <div className="stack">
      <Link to="/arriendos">← Volver a arriendos</Link>
      <div className="card row-between">
        <div>
          <h1 style={{ margin: 0 }}>{property?.name ?? 'Inmueble'}</h1>
          <p className="text-muted" style={{ margin: 0 }}>
            {rental.tenantAlias ?? 'Sin alias registrado'}
          </p>
        </div>
        <StatusBadge label={label(RENTAL_STATUS_LABELS, rental.status)} tone={toneFor.rental(rental.status)} />
      </div>

      <div className="card">
        <div className="row-between">
          <h2 className="card-title">Datos del arriendo</h2>
          {rental.status !== 'ended' && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
              Editar
            </button>
          )}
        </div>
        <div className="form-grid">
          <p>
            <strong>Canon:</strong> {formatMoney(rental.expectedAmount, rental.currency)}
          </p>
          <p>
            <strong>Día de cobro:</strong> {rental.dueDay}
          </p>
          <p>
            <strong>Vigencia:</strong> {formatCalendarDate(rental.startsOn)} – {formatCalendarDate(rental.endsOn)}
          </p>
          <p>
            <strong>Generación automática:</strong> {rental.autoGenerate ? 'Activa' : 'Inactiva'}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="row-between">
          <h2 className="card-title">Cobros</h2>
          {rental.status !== 'ended' && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreatingCharge(true)}>
              Nuevo cobro
            </button>
          )}
        </div>
        {loadingCharges && <SkeletonTable rows={2} cols={5} label="Cargando cobros…" />}
        {!loadingCharges && charges && charges.items.length === 0 && <EmptyBlock title="Sin cobros registrados" />}
        {!loadingCharges && charges && charges.items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Período</th>
                  <th>Vence</th>
                  <th>Monto esperado</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {charges.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {formatCalendarDate(c.periodStart)} – {formatCalendarDate(c.periodEnd)}
                    </td>
                    <td>
                      {formatCalendarDate(c.dueDate)}
                      {OPEN_STATUSES.has(c.status) && <div className="text-muted">{describeDueDate(c.dueDate)}</div>}
                    </td>
                    <td>{formatMoney(c.expectedAmount, c.currency)}</td>
                    <td>
                      <StatusBadge label={label(CHARGE_STATUS_LABELS, c.status)} tone={toneFor.charge(c.status)} />
                    </td>
                    <td className="row">
                      {OPEN_STATUSES.has(c.status) && (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingCharge(c)}>
                            Editar
                          </button>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirming(c)}>
                            Confirmar recepción
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <RentalFormModal rental={rental} onClose={() => setEditing(false)} />}
      {creatingCharge && <ChargeFormModal rentalId={rental.id} onClose={() => setCreatingCharge(false)} />}
      {editingCharge && (
        <ChargeFormModal rentalId={rental.id} charge={editingCharge} onClose={() => setEditingCharge(null)} />
      )}
      {confirming && <ConfirmChargeModal rentalId={rental.id} charge={confirming} onClose={() => setConfirming(null)} />}
    </div>
  )
}
