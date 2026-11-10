import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { Pagination } from '../../components/Pagination'
import { formatMoney } from '../../lib/format/money'
import { RENTAL_STATUS_LABELS, label } from '../../lib/format/labels'
import { useProperties } from '../properties/hooks'
import { useRentals } from './hooks'
import { RentalFormModal } from './RentalFormModal'
import type { RentalStatus } from '../../lib/api/types'

export function RentalsPage() {
  const [page, setPage] = useState(1)
  const [propertyId, setPropertyId] = useState('')
  const [status, setStatus] = useState<RentalStatus | ''>('')
  const [creating, setCreating] = useState(false)
  const { data: properties } = useProperties({ pageSize: 100, status: 'active' })
  const { data, isLoading, isError, error, refetch } = useRentals({
    page,
    pageSize: 20,
    propertyId: propertyId || undefined,
    status: status || undefined,
  })

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Arriendos</h1>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          Nuevo arriendo
        </button>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
        <select aria-label="Filtrar por inmueble" value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setPage(1) }}>
          <option value="">Todos los inmuebles</option>
          {properties?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select aria-label="Filtrar por estado" value={status} onChange={(e) => { setStatus(e.target.value as RentalStatus | ''); setPage(1) }}>
          <option value="">Todos los estados</option>
          {Object.entries(RENTAL_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <LoadingBlock label="Cargando arriendos…" />}
      {isError && <ErrorBlock error={error} onRetry={refetch} />}
      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyBlock
          title="Sin arriendos"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Nuevo arriendo
            </button>
          }
        />
      )}
      {!isLoading && !isError && data && data.items.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Inmueble</th>
                  <th>Alias</th>
                  <th>Canon</th>
                  <th>Día de cobro</th>
                  <th>Estado</th>
                  <th>Recurrencia</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/arriendos/${r.id}`}>
                        {properties?.items.find((p) => p.id === r.propertyId)?.name ?? r.propertyId}
                      </Link>
                    </td>
                    <td>{r.tenantAlias ?? '—'}</td>
                    <td>{formatMoney(r.expectedAmount, r.currency)}</td>
                    <td>{r.dueDay}</td>
                    <td>
                      <StatusBadge label={label(RENTAL_STATUS_LABELS, r.status)} tone={toneFor.rental(r.status)} />
                    </td>
                    <td>{r.autoGenerate ? 'Automática' : 'Manual'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={20} total={data.total} onPageChange={setPage} />
        </div>
      )}

      {creating && <RentalFormModal onClose={() => setCreating(false)} />}
    </div>
  )
}
