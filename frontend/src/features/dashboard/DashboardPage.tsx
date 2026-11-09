import { useNavigate } from 'react-router-dom'
import { ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { resourcePathToRoute } from '../../lib/navigation'
import { formatMoney } from '../../lib/format/money'
import { ATTENTION_CONDITION_LABELS, label } from '../../lib/format/labels'
import { useAttention } from '../attention/hooks'
import { useCases } from '../cases/hooks'
import { useDashboardSummary } from './hooks'

function Kpi({ label, value, tone }: { label: string; value: number; tone?: 'danger' | 'warning' }) {
  return (
    <div className="card" style={{ flex: '1 1 140px' }}>
      <div className="text-muted" style={{ fontSize: '0.8rem' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.6rem', fontWeight: 800, color: tone === 'danger' ? 'var(--color-danger)' : tone === 'warning' ? 'var(--color-warning)' : undefined }}>
        {value}
      </div>
    </div>
  )
}

export function DashboardPage() {
  const { data, isLoading, isError, error, refetch } = useDashboardSummary()
  const { data: attention } = useAttention({ pageSize: 8 })
  const { data: processingCases } = useCases({ status: 'processing', pageSize: 5 })
  const navigate = useNavigate()

  if (isLoading) return <LoadingBlock label="Cargando resumen…" />
  if (isError || !data) return <ErrorBlock error={error} onRetry={refetch} />

  return (
    <div className="stack">
      <h1>Resumen</h1>

      <div className="row" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <Kpi label="Obligaciones vencidas" value={data.obligations.periodsOverdue} tone="danger" />
        <Kpi label="Obligaciones por vencer" value={data.obligations.periodsDueSoon} tone="warning" />
        <Kpi label="Cobros vencidos" value={data.rentCharges.overdue} tone="danger" />
        <Kpi label="Cobros por vencer" value={data.rentCharges.dueSoon} tone="warning" />
        <Kpi label="Contratos por vencer" value={data.contracts.endingSoon} tone="warning" />
        <Kpi label="Revisiones pendientes" value={data.hitl.pending} tone="warning" />
        <Kpi label="Alertas sin leer" value={data.alerts.unread} />
        <Kpi label="Casos abiertos" value={data.cases.open} />
      </div>

      <div className="card">
        <h2 className="card-title">Lo más urgente</h2>
        {!attention || attention.items.length === 0 ? (
          <p className="text-muted">Aún no tienes obligaciones. Crea la primera o sube una factura.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {attention.items.map((item) => (
              <li
                key={`${item.kind}-${item.id}`}
                className="row-between"
                style={{ cursor: 'pointer', borderBottom: '1px solid var(--color-border)', paddingBottom: '0.5rem' }}
                onClick={() => navigate(resourcePathToRoute(item.resource.path))}
              >
                <div>
                  <strong>{item.title}</strong>
                  <div className="text-muted">{item.description}</div>
                </div>
                <span className="badge badge-neutral">{label(ATTENTION_CONDITION_LABELS, item.condition)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {processingCases && processingCases.items.length > 0 && (
        <div className="card">
          <h2 className="card-title">Casos en procesamiento</h2>
          <p className="text-muted">{processingCases.total} caso(s) en proceso de interpretación.</p>
        </div>
      )}

      <div className="card">
        <h2 className="card-title">Dinero</h2>
        <p className="text-muted">{data.money.note}</p>
        <div className="form-grid">
          <div>
            <h3>Obligaciones abiertas</h3>
            {data.money.obligationsOpen.length === 0 ? (
              <p className="text-muted">Sin montos pendientes.</p>
            ) : (
              data.money.obligationsOpen.map((row) => (
                <p key={row.currency}>
                  {formatMoney(row.total, row.currency)} ({row.count} período(s))
                </p>
              ))
            )}
          </div>
          <div>
            <h3>Arriendo por recibir</h3>
            {data.money.rentOpen.length === 0 ? (
              <p className="text-muted">Sin montos pendientes.</p>
            ) : (
              data.money.rentOpen.map((row) => <p key={row.currency}>{formatMoney(row.total, row.currency)}</p>)
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
