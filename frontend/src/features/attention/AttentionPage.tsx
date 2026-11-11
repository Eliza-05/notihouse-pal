import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AttentionRow } from '../../components/AttentionRow'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { Pagination } from '../../components/Pagination'
import { resourcePathToRoute } from '../../lib/navigation'
import { useMarkAlertRead } from '../alerts/hooks'
import { useAttention } from './hooks'
import type { AttentionItem } from '../../lib/api/types'

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
        <section className="glass" style={{ padding: 8 }}>
          <ul className="list">
            {data.items.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <AttentionRow item={item} onOpen={openItem} showAction />
              </li>
            ))}
          </ul>
          <div style={{ padding: '0 10px' }}>
            <Pagination page={page} pageSize={20} total={data.total} onPageChange={setPage} />
          </div>
        </section>
      )}
    </div>
  )
}
