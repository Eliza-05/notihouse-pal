import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { StatusBadge } from '../../components/StatusBadge'
import { Pagination } from '../../components/Pagination'
import { formatCalendarDate } from '../../lib/format/dates'
import { formatMoney } from '../../lib/format/money'
import { ATTENTION_CONDITION_LABELS, SUGGESTED_ACTION_LABELS, label } from '../../lib/format/labels'
import { resourcePathToRoute } from '../../lib/navigation'
import { useMarkAlertRead } from '../alerts/hooks'
import { useAttention } from './hooks'
import type { AttentionCondition, AttentionItem } from '../../lib/api/types'

const CONDITION_TONE: Record<AttentionCondition, 'danger' | 'warning' | 'neutral'> = {
  overdue: 'danger',
  due_today: 'warning',
  pending: 'warning',
  due_soon: 'warning',
  upcoming: 'neutral',
}

export function AttentionPage() {
  const [page, setPage] = useState(1)
  const navigate = useNavigate()
  const { data, isLoading, isError, error, refetch } = useAttention({ page, pageSize: 20 })
  const markRead = useMarkAlertRead()

  function openItem(item: AttentionItem) {
    if (item.alert && !item.alert.read) markRead.mutate(item.alert.id)
    navigate(resourcePathToRoute(item.resource.path))
  }

  return (
    <div className="stack">
      <h1>Bandeja de atención</h1>
      <p className="text-muted">Todo lo que necesita tu revisión, ordenado por urgencia.</p>

      {isLoading && <LoadingBlock label="Cargando bandeja…" />}
      {isError && <ErrorBlock error={error} onRetry={refetch} />}
      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyBlock title="No tienes nada pendiente" description="Aquí verás vencimientos, cobros y revisiones que requieran tu atención." />
      )}
      {!isLoading && !isError && data && data.items.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Condición</th>
                  <th>Qué</th>
                  <th>Cuándo</th>
                  <th>Monto</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={`${item.kind}-${item.id}`}>
                    <td>
                      <StatusBadge label={label(ATTENTION_CONDITION_LABELS, item.condition)} tone={CONDITION_TONE[item.condition]} />
                    </td>
                    <td>
                      <strong>{item.title}</strong>
                      <div className="text-muted">{item.description}</div>
                    </td>
                    <td>{formatCalendarDate(item.relevantDate)}</td>
                    <td>{item.amount ? formatMoney(item.amount, item.currency ?? 'COP') : '—'}</td>
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => openItem(item)}>
                        {label(SUGGESTED_ACTION_LABELS, item.suggestedAction)}
                      </button>
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
