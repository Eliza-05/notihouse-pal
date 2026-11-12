import { useState } from 'react'
import { LoadingButton } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toasts'
import { friendlyError } from '../../lib/api/messages'
import { formatMoneyWithCurrency } from '../../lib/format/money'
import { formatLongDate } from '../../lib/format/dates'
import { useConfirmOccurrence } from './hooks'
import type { ConfirmationResult, ObligationOccurrence } from '../../lib/api/types'

export function ConfirmOccurrenceModal({
  obligationId,
  occurrence,
  onClose,
}: {
  obligationId: string
  occurrence: ObligationOccurrence
  onClose: () => void
}) {
  const [result, setResult] = useState<ConfirmationResult>('paid')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const confirm = useConfirmOccurrence(obligationId)
  const toast = useToast()

  async function handleConfirm() {
    setError(null)
    try {
      await confirm.mutateAsync({ occurrenceId: occurrence.id, input: { result, reference: reference || undefined } })
      toast.success(result === 'paid' ? 'Declaraste el período como pagado.' : 'Declaraste el período como atendido.')
      onClose()
    } catch (err) {
      setError(friendlyError(err, 'save'))
    }
  }

  return (
    <Modal title="Confirmar pago del período" onClose={onClose}>
      <p>
        Período con vencimiento el {formatLongDate(occurrence.dueDate)}
        {occurrence.amount ? <> por <strong>{formatMoneyWithCurrency(occurrence.amount, occurrence.currency)}</strong></> : null}.
      </p>
      <p>
        Declaras que <strong>{result === 'paid' ? 'pagaste' : 'atendiste'}</strong> esta obligación. NotiHouse-Pal no
        realiza ni verifica pagos: es tu declaración. Después de confirmarlo, este período ya no se podrá editar desde la aplicación.
      </p>
      <div className="field">
        <label htmlFor="result">Resultado</label>
        <select id="result" value={result} onChange={(e) => setResult(e.target.value as ConfirmationResult)}>
          <option value="paid">Pagado</option>
          <option value="attended">Atendido</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="reference">Referencia (opcional)</label>
        <input id="reference" maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <LoadingButton loading={confirm.isPending} loadingText="Guardando…" onClick={handleConfirm}>
          {result === 'paid' ? 'Declarar como pagado' : 'Declarar como atendido'}
        </LoadingButton>
      </div>
    </Modal>
  )
}
