import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { StatusBadge, toneFor } from '../../components/StatusBadge'
import { Pagination } from '../../components/Pagination'
import { formatCalendarDate } from '../../lib/format/dates'
import { ALERT_SEVERITY_LABELS, ALERT_STATE_LABELS, ALERT_TYPE_LABELS, label } from '../../lib/format/labels'
import { resourcePathToRoute } from '../../lib/navigation'
import { ApiError } from '../../lib/api/errors'
import { useAlerts, useDismissAlert, useMarkAlertRead } from './hooks'
import type { Alert, AlertState } from '../../lib/api/types'

const STATE_FILTERS: { value: AlertState | ''; label: string }[] = [
  { value: '', label: 'Todas' },
  { value: 'active', label: 'Vigentes' },
  { value: 'dismissed', label: 'Descartadas' },
  { value: 'resolved', label: 'Resueltas' },
]

export function AlertsPage() {
  const [page, setPage] = useState(1)
  const [state, setState] = useState<AlertState | ''>('active')
  const navigate = useNavigate()
  const { data, isLoading, isError, error, refetch } = useAlerts({
    page,
    pageSize: 20,
    state: state || undefined,
    order: 'desc',
  })
  const markRead = useMarkAlertRead()
  const dismiss = useDismissAlert()
  const [dismissError, setDismissError] = useState<string | null>(null)

  function openResource(alert: Alert) {
    if (!alert.read) markRead.mutate(alert.id)
    navigate(resourcePathToRoute(alert.resource.path))
  }

  async function handleDismiss(alert: Alert) {
    setDismissError(null)
    try {
      await dismiss.mutateAsync(alert.id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDismissError('Ya no requiere atención: se actualizó.')
        void refetch()
      } else {
        setDismissError('No se pudo descartar la alerta.')
      }
    }
  }

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Alertas</h1>
        <div className="row row-wrap" role="group" aria-label="Filtrar por estado">
          {STATE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`btn btn-sm ${state === f.value ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                setState(f.value)
                setPage(1)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-muted">
        Avisos internos dentro de la aplicación. NotiHouse-Pal no envía notificaciones push, correos ni mensajes:
        solo verás esto cuando abras o actualices la app.
      </p>

      {dismissError && <p role="alert" className="field-error">{dismissError}</p>}

      {isLoading && <LoadingBlock label="Cargando alertas…" />}
      {isError && <ErrorBlock error={error} onRetry={refetch} />}
      {!isLoading && !isError && data && data.items.length === 0 && (
        <EmptyBlock
          title="Todavía no hay alertas"
          description="Aparecerán cuando se evalúen tus vencimientos."
        />
      )}
      {!isLoading && !isError && data && data.items.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Severidad</th>
                  <th>Fecha</th>
                  <th>Mensaje</th>
                  <th>Estado</th>
                  <th>Leída</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((alert) => (
                  <tr key={alert.id}>
                    <td>{label(ALERT_TYPE_LABELS, alert.type)}</td>
                    <td>
                      <StatusBadge label={label(ALERT_SEVERITY_LABELS, alert.severity)} tone={toneFor.alertSeverity(alert.severity)} />
                    </td>
                    <td>{formatCalendarDate(alert.relevantDate)}</td>
                    <td>{alert.message}</td>
                    <td>{label(ALERT_STATE_LABELS, alert.state)}</td>
                    <td>{alert.read ? 'Sí' : 'No'}</td>
                    <td className="row">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => openResource(alert)}>
                        Ver
                      </button>
                      {alert.state === 'active' && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={dismiss.isPending}
                          onClick={() => handleDismiss(alert)}
                        >
                          Descartar aviso
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
    </div>
  )
}
