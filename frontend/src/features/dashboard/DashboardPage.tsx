import { Link, useNavigate } from 'react-router-dom'
import { AttentionRow } from '../../components/AttentionRow'
import { ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { resourcePathToRoute } from '../../lib/navigation'
import { formatMoney } from '../../lib/format/money'
import { useMarkAlertRead } from '../alerts/hooks'
import { useAttention } from '../attention/hooks'
import { useCases } from '../cases/hooks'
import { useDashboardSummary } from './hooks'
import type { AttentionItem } from '../../lib/api/types'

function Kpi({ label, value, hint, tone, to }: { label: string; value: number; hint: string; tone?: 'danger' | 'warning'; to: string }) {
  const toneClass = value > 0 && tone ? `tone-${tone}` : ''
  return (
    <Link to={to} className={`glass kpi ${toneClass}`} style={{ textDecoration: 'none', color: 'inherit', fontWeight: 'inherit' }}>
      <span className="lbl">{label}</span>
      <span className="num">{value}</span>
      <span className="text-muted kpi-hint" style={{ fontSize: '0.76rem' }}>
        {hint}
      </span>
    </Link>
  )
}

export function DashboardPage() {
  const { data, isLoading, isError, error, refetch } = useDashboardSummary()
  const { data: attention } = useAttention({ pageSize: 6 })
  const { data: processingCases } = useCases({ status: 'processing', pageSize: 5 })
  const markRead = useMarkAlertRead()
  const navigate = useNavigate()

  if (isLoading) return <LoadingBlock label="Cargando resumen…" />
  if (isError || !data) return <ErrorBlock error={error} onRetry={refetch} />

  function openItem(item: AttentionItem) {
    if (item.alert && !item.alert.read) markRead.mutate(item.alert.id)
    navigate(resourcePathToRoute(item.resource.path))
  }

  const overdue = data.obligations.periodsOverdue + data.rentCharges.overdue

  return (
    <div className="stack" style={{ gap: 22 }}>
      <h1 className="visually-hidden">Resumen</h1>

      <div className="kpi-grid">
        <Kpi label="Vencidos" value={overdue} hint={`${data.obligations.periodsOverdue} obligación(es) · ${data.rentCharges.overdue} cobro(s)`} tone="danger" to="/atencion" />
        <Kpi label="Obligaciones por vencer" value={data.obligations.periodsDueSoon} hint="Períodos en la ventana de aviso" tone="warning" to="/obligaciones" />
        <Kpi label="Cobros por vencer" value={data.rentCharges.dueSoon} hint="Arriendos por recibir pronto" tone="warning" to="/arriendos" />
        <Kpi label="Contratos por vencer" value={data.contracts.endingSoon} hint="Próximos a revisión" tone="warning" to="/contratos" />
        <Kpi label="Revisiones pendientes" value={data.hitl.pending} hint="Propuestas de IA esperando tu decisión" tone="warning" to="/casos" />
        <Kpi label="Alertas sin leer" value={data.alerts.unread} hint={`${data.cases.open} caso(s) abierto(s)`} to="/alertas" />
      </div>

      <section className="glass" style={{ padding: '18px 8px 8px' }}>
        <div className="sec-head" style={{ padding: '0 12px' }}>
          <h2>Próximos vencimientos</h2>
          <span className="hint">Ordenados por urgencia</span>
        </div>
        {!attention || attention.items.length === 0 ? (
          <p className="text-muted" style={{ padding: '4px 14px 14px' }}>
            Aún no tienes pendientes. Crea una obligación o sube una factura.
          </p>
        ) : (
          <ul className="list">
            {attention.items.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <AttentionRow item={item} onOpen={openItem} />
              </li>
            ))}
          </ul>
        )}
        {attention && attention.total > attention.items.length && (
          <div style={{ padding: '8px 14px 8px' }}>
            <Link to="/atencion">Ver la bandeja completa ({attention.total})</Link>
          </div>
        )}
      </section>

      {processingCases && processingCases.items.length > 0 && (
        <section className="glass" style={{ padding: '18px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>Casos en procesamiento</div>
            <div className="text-muted" style={{ fontSize: '0.8rem', marginTop: 2 }}>
              {processingCases.total} caso(s) en interpretación. Te avisaremos cuando requieran tu revisión.
            </div>
          </div>
          <Link to="/casos" className="btn btn-secondary">
            Ver mis solicitudes
          </Link>
        </section>
      )}

      <section>
        <div className="sec-head">
          <h2>Dinero</h2>
          <span className="hint">{data.money.note}</span>
        </div>
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))' }}>
          <div className="glass kpi">
            <span className="lbl">Obligaciones abiertas</span>
            {data.money.obligationsOpen.length === 0 ? (
              <span className="text-muted">Sin montos pendientes.</span>
            ) : (
              data.money.obligationsOpen.map((row) => (
                <span key={row.currency} className="row-amount" style={{ textAlign: 'left', fontSize: '1.15rem' }}>
                  {formatMoney(row.total, row.currency)}{' '}
                  <span className="text-muted" style={{ fontSize: '0.76rem', fontFamily: 'var(--font-body)' }}>
                    {row.count} período(s)
                  </span>
                </span>
              ))
            )}
          </div>
          <div className="glass kpi">
            <span className="lbl">Arriendo por recibir</span>
            {data.money.rentOpen.length === 0 ? (
              <span className="text-muted">Sin montos pendientes.</span>
            ) : (
              data.money.rentOpen.map((row) => (
                <span key={row.currency} className="row-amount" style={{ textAlign: 'left', fontSize: '1.15rem' }}>
                  {formatMoney(row.total, row.currency)}
                </span>
              ))
            )}
          </div>
        </div>
      </section>

      <footer className="glass scope-note">
        <b>Recuerda:</b> NotiHouse Pal no ejecuta pagos ni cobros. Organiza la información y te avisa; la confirmación de pago o
        recepción siempre la haces tú.
      </footer>
    </div>
  )
}
