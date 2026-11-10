import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { formatMoney } from '../../lib/format/money'
import { formatCalendarDate } from '../../lib/format/dates'
import { PROPERTY_STATUS_LABELS, label } from '../../lib/format/labels'
import { useObligations } from '../obligations/hooks'
import { useRentals } from '../rentals/hooks'
import { useContracts } from '../contracts/hooks'
import { useProperty } from './hooks'
import { PropertyFormModal } from './PropertyFormModal'

export function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: property, isLoading, isError, error, refetch } = useProperty(id)
  const { data: obligations } = useObligations({ propertyId: id, pageSize: 50 })
  const { data: rentals } = useRentals({ propertyId: id, pageSize: 50 })
  const { data: contracts } = useContracts({ propertyId: id, pageSize: 50 })
  const [editing, setEditing] = useState(false)

  if (isLoading) return <LoadingBlock label="Cargando inmueble…" />
  if (isError || !property) return <ErrorBlock error={error} onRetry={refetch} />

  return (
    <div className="stack">
      <Link to="/inmuebles">← Volver a inmuebles</Link>
      <div className="card row-between">
        <div>
          <h1 style={{ margin: 0 }}>{property.name}</h1>
          <p className="text-muted" style={{ margin: 0 }}>
            {property.address ?? 'Sin dirección registrada'}
          </p>
        </div>
        <div className="row">
          <StatusBadge label={label(PROPERTY_STATUS_LABELS, property.status)} tone={toneFor.property(property.status)} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            Editar
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Obligaciones ({obligations?.total ?? 0})</h2>
        {!obligations || obligations.items.length === 0 ? (
          <p className="text-muted">Sin obligaciones en este inmueble.</p>
        ) : (
          <ul>
            {obligations.items.map((o) => (
              <li key={o.id}>
                <Link to={`/obligaciones/${o.id}`}>{o.providerName}</Link> — {formatMoney(o.expectedAmount, o.currency)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Arriendos ({rentals?.total ?? 0})</h2>
        {!rentals || rentals.items.length === 0 ? (
          <p className="text-muted">Sin arriendos en este inmueble.</p>
        ) : (
          <ul>
            {rentals.items.map((r) => (
              <li key={r.id}>
                <Link to={`/arriendos/${r.id}`}>{r.tenantAlias ?? 'Arriendo'}</Link> — {formatMoney(r.expectedAmount, r.currency)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Contratos ({contracts?.total ?? 0})</h2>
        {!contracts || contracts.items.length === 0 ? (
          <p className="text-muted">Sin contratos en este inmueble.</p>
        ) : (
          <ul>
            {contracts.items.map((c) => (
              <li key={c.id}>
                Vigencia {formatCalendarDate(c.startsOn)} – {formatCalendarDate(c.endsOn)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && <PropertyFormModal property={property} onClose={() => setEditing(false)} />}
    </div>
  )
}
