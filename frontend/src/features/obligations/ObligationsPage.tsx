import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { EmptyBlock, ErrorBlock } from '../../components/StateBlocks'
import { SkeletonTable } from '../../components/Feedback'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { Pagination } from '../../components/Pagination'
import { listAmountText, recurrenceText } from './presentation'
import { OBLIGATION_CATEGORY_LABELS, OBLIGATION_STATUS_LABELS, label } from '../../lib/format/labels'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { useProperties } from '../properties/hooks'
import { useObligations } from './hooks'
import { ObligationFormModal } from './ObligationFormModal'
import type { ObligationCategory, ObligationStatus } from '../../lib/api/types'

export function ObligationsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ObligationStatus | ''>('')
  const [category, setCategory] = useState<ObligationCategory | ''>('')
  const [propertyId, setPropertyId] = useState('')
  const [unassigned, setUnassigned] = useState(false)
  const [creating, setCreating] = useState(false)
  const debouncedSearch = useDebouncedValue(search)
  const q = debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined

  const { data: properties } = useProperties({ pageSize: 100, status: 'active' })
  const { data, isLoading, isError, error, refetch } = useObligations({
    page,
    pageSize: 20,
    q,
    status: status || undefined,
    category: category || undefined,
    propertyId: unassigned ? undefined : propertyId || undefined,
    unassigned: unassigned || undefined,
  })

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Obligaciones</h1>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          Nueva obligación
        </button>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
        <div className="field" style={{ minWidth: 220, marginBottom: 0 }}>
          <label htmlFor="obl-search" className="visually-hidden">
            Buscar por proveedor o concepto
          </label>
          <div className="row" style={{ position: 'relative' }}>
            <Search size={16} style={{ position: 'absolute', left: 10, color: 'var(--color-text-muted)' }} aria-hidden="true" />
            <input
              id="obl-search"
              placeholder="Buscar por proveedor o concepto…"
              value={search}
              style={{ paddingLeft: '2rem' }}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
            />
          </div>
        </div>
        <select aria-label="Filtrar por estado" value={status} onChange={(e) => { setStatus(e.target.value as ObligationStatus | ''); setPage(1) }}>
          <option value="">Todos los estados</option>
          {Object.entries(OBLIGATION_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select aria-label="Filtrar por categoría" value={category} onChange={(e) => { setCategory(e.target.value as ObligationCategory | ''); setPage(1) }}>
          <option value="">Todas las categorías</option>
          {Object.entries(OBLIGATION_CATEGORY_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          aria-label="Filtrar por inmueble"
          value={propertyId}
          disabled={unassigned}
          onChange={(e) => { setPropertyId(e.target.value); setPage(1) }}
        >
          <option value="">Todos los inmuebles</option>
          {properties?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="row" style={{ fontSize: '0.85rem', gap: '0.4rem' }}>
          <input
            type="checkbox"
            checked={unassigned}
            onChange={(e) => {
              setUnassigned(e.target.checked)
              setPage(1)
            }}
          />
          Sin inmueble asignado
        </label>
      </div>

      {isLoading && <SkeletonTable rows={6} cols={5} label="Cargando obligaciones…" />}
      {isError && <ErrorBlock error={error} onRetry={refetch} />}
      {!isLoading && !isError && data && data.items.length === 0 && q && (
        <EmptyBlock title={`Ningún resultado para "${q}"`} />
      )}
      {!isLoading && !isError && data && data.items.length === 0 && !q && (
        <EmptyBlock
          title="Sin obligaciones"
          description="Crea la primera o sube una factura desde Documentos."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Nueva obligación
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
                  <th>Proveedor</th>
                  <th>Concepto</th>
                  <th>Categoría</th>
                  <th>Monto base</th>
                  <th>Vence</th>
                  <th>Estado</th>
                  <th>Recurrencia</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/obligaciones/${o.id}`}>{o.providerName}</Link>
                    </td>
                    <td>{o.concept}</td>
                    <td>{label(OBLIGATION_CATEGORY_LABELS, o.category)}</td>
                    <td>{(() => { const a = listAmountText(o); return a.muted ? <span className="text-muted">{a.text}</span> : a.text })()}</td>
                    <td>{o.dueDay ? `día ${o.dueDay}` : <span className="text-muted">Según cada período</span>}</td>
                    <td>
                      <StatusBadge label={label(OBLIGATION_STATUS_LABELS, o.status)} tone={toneFor.obligation(o.status)} />
                    </td>
                    <td>{recurrenceText(o)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={20} total={data.total} onPageChange={setPage} />
        </div>
      )}

      {creating && <ObligationFormModal onClose={() => setCreating(false)} />}
    </div>
  )
}
