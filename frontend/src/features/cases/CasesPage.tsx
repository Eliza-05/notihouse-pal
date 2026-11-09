import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { Pagination } from '../../components/Pagination'
import { formatInstant } from '../../lib/format/dates'
import { CASE_STATUS_LABELS, CASE_TYPE_LABELS, SOURCE_LABELS, label } from '../../lib/format/labels'
import { useCases } from './hooks'
import type { CaseStatus } from '../../lib/api/types'

export function CasesPage() {
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<CaseStatus | ''>('')
  const { data, isLoading, isError, error, refetch } = useCases({ page, pageSize: 20, status: status || undefined })

  return (
    <div className="stack">
      <h1>Mis solicitudes</h1>
      <p className="text-muted">
        Cada factura, nota de voz o mensaje enviado al asistente queda registrado aquí como un caso independiente.
      </p>

      <select value={status} onChange={(e) => { setStatus(e.target.value as CaseStatus | ''); setPage(1) }} style={{ maxWidth: 220 }}>
        <option value="">Todos los estados</option>
        {Object.entries(CASE_STATUS_LABELS).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>

      {isLoading && <LoadingBlock label="Cargando solicitudes…" />}
      {isError && <ErrorBlock error={error} onRetry={refetch} />}
      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyBlock title="Aún no has enviado documentos ni notas de voz" />
      )}
      {!isLoading && !isError && data && data.items.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Origen</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>{label(CASE_TYPE_LABELS, c.type)}</td>
                    <td>{label(SOURCE_LABELS, c.source)}</td>
                    <td>
                      <StatusBadge label={label(CASE_STATUS_LABELS, c.status)} tone={toneFor.case(c.status)} />
                    </td>
                    <td>{formatInstant(c.createdAt)}</td>
                    <td>
                      <Link to={`/casos/${c.id}`}>Ver</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={20} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  )
}
