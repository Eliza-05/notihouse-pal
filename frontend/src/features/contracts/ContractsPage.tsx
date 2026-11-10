import { useState } from 'react'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { Pagination } from '../../components/Pagination'
import { formatCalendarDate, describeDueDate } from '../../lib/format/dates'
import { CONTRACT_STATUS_LABELS, label } from '../../lib/format/labels'
import { useProperties } from '../properties/hooks'
import { useContracts, useUpdateContract } from './hooks'
import { ContractFormModal } from './ContractFormModal'
import { Modal } from '../../components/Modal'
import type { Contract, ContractStatus } from '../../lib/api/types'

export function ContractsPage() {
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<ContractStatus | ''>('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Contract | null>(null)
  const [terminating, setTerminating] = useState<Contract | null>(null)
  const { data: properties } = useProperties({ pageSize: 100 })
  const { data, isLoading, isError, error, refetch } = useContracts({ page, pageSize: 20, status: status || undefined })
  const update = useUpdateContract()

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Contratos</h1>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          Registrar contrato
        </button>
      </div>
      <p className="text-muted">NotiHouse-Pal no genera, firma ni renueva contratos.</p>

      <select aria-label="Filtrar por estado" value={status} onChange={(e) => { setStatus(e.target.value as ContractStatus | ''); setPage(1) }} style={{ maxWidth: 200 }}>
        <option value="">Todos los estados</option>
        {Object.entries(CONTRACT_STATUS_LABELS).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>

      {isLoading && <LoadingBlock label="Cargando contratos…" />}
      {isError && <ErrorBlock error={error} onRetry={refetch} />}
      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyBlock
          title="Sin contratos registrados"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Registrar contrato
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
                  <th>Vigencia</th>
                  <th>Vence</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>{properties?.items.find((p) => p.id === c.propertyId)?.name ?? c.propertyId}</td>
                    <td>
                      {formatCalendarDate(c.startsOn)} – {formatCalendarDate(c.endsOn)}
                    </td>
                    <td>{c.status === 'active' ? describeDueDate(c.endsOn) : '—'}</td>
                    <td>
                      <StatusBadge label={label(CONTRACT_STATUS_LABELS, c.status)} tone={toneFor.contract(c.status)} />
                    </td>
                    <td className="row">
                      {c.status === 'active' && (
                        <>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(c)}>
                            Corregir
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTerminating(c)}>
                            Terminar
                          </button>
                        </>
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

      {creating && <ContractFormModal onClose={() => setCreating(false)} />}
      {editing && <ContractFormModal contract={editing} onClose={() => setEditing(null)} />}
      {terminating && (
        <Modal title="Terminar contrato" onClose={() => setTerminating(null)}>
          <p>¿Marcar este contrato como terminado? Esta acción es final.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setTerminating(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={update.isPending}
              onClick={async () => {
                await update.mutateAsync({ id: terminating.id, input: { status: 'terminated' } })
                setTerminating(null)
              }}
            >
              Terminar
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
