import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { SkeletonTable } from '../../components/Feedback'
import { EmptyBlock, ErrorBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { Pagination } from '../../components/Pagination'
import { LoadingButton } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toasts'
import { friendlyError } from '../../lib/api/messages'
import { PROPERTY_STATUS_LABELS, label } from '../../lib/format/labels'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { useProperties, useUpdateProperty } from './hooks'
import { PropertyFormModal } from './PropertyFormModal'
import type { Property } from '../../lib/api/types'

export function PropertiesPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search)
  const q = debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined
  const { data, isLoading, isError, error, refetch } = useProperties({ page, pageSize: 20, q })
  const [editing, setEditing] = useState<Property | 'new' | null>(null)
  const toast = useToast()
  const [actionError, setActionError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState<Property | null>(null)
  const update = useUpdateProperty()

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Inmuebles</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Registrar inmueble
        </button>
      </div>

      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="property-search" className="visually-hidden">
          Buscar por nombre
        </label>
        <div className="row" style={{ position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 10, color: 'var(--color-text-muted)' }} aria-hidden="true" />
          <input
            id="property-search"
            placeholder="Buscar por nombre…"
            value={search}
            style={{ paddingLeft: '2rem' }}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
        </div>
      </div>

      {isLoading && <SkeletonTable rows={4} cols={4} label="Cargando inmuebles…" />}
      {isError && <ErrorBlock error={error} onRetry={refetch} />}
      {!isLoading && !isError && data && data.items.length === 0 && q && (
        <EmptyBlock title={`Ningún resultado para "${q}"`} />
      )}
      {!isLoading && !isError && data && data.items.length === 0 && !q && (
        <EmptyBlock
          title="Registra tu primer inmueble"
          description="Los inmuebles te permiten agrupar obligaciones, arriendos y contratos."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              Registrar inmueble
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
                  <th>Nombre</th>
                  <th>Dirección</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/inmuebles/${p.id}`}>{p.name}</Link>
                    </td>
                    <td>{p.address ?? '—'}</td>
                    <td>
                      <StatusBadge label={label(PROPERTY_STATUS_LABELS, p.status)} tone={toneFor.property(p.status)} />
                    </td>
                    <td className="row">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(p)}>
                        Editar
                      </button>
                      {p.status !== 'archived' && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setArchiving(p)}>
                          Archivar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={20} total={data.total} onPageChange={setPage} />
        </div>
      )}

      {editing && (
        <PropertyFormModal property={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />
      )}

      {archiving && (
        <Modal title="Archivar inmueble" onClose={() => setArchiving(null)}>
          <p>
            Un inmueble archivado no admite nuevas obligaciones ni arriendos. ¿Archivar <strong>{archiving.name}</strong>?
          </p>
          {actionError && <p className="field-error" role="alert">{actionError}</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setArchiving(null)} disabled={update.isPending}>
              Cancelar
            </button>
            <LoadingButton
              className="btn btn-danger"
              loading={update.isPending}
              loadingText="Archivando…"
              onClick={async () => {
                setActionError(null)
                try {
                  await update.mutateAsync({ id: archiving.id, input: { status: 'archived' } })
                  toast.success('Inmueble archivado.')
                  setArchiving(null)
                } catch (err) {
                  setActionError(friendlyError(err, 'save'))
                }
              }}
            >
              Sí, archivar
            </LoadingButton>
          </div>
        </Modal>
      )}
    </div>
  )
}
