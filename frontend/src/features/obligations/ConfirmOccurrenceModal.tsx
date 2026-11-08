import { useState } from 'react'
import { Modal } from '../../components/Modal'
import { ApiError } from '../../lib/api/errors'
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

  async function handleConfirm() {
    setError(null)
    try {
      await confirm.mutateAsync({ occurrenceId: occurrence.id, input: { result, reference: reference || undefined } })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.messages.join(' ') : 'No se pudo registrar la confirmación.')
    }
  }

  return (
    <Modal title="Confirmar período" onClose={onClose}>
      <p>
        Declaras que <strong>{result === 'paid' ? 'pagaste' : 'atendiste'}</strong> esta obligación. NotiHouse-Pal no
        realiza ni verifica pagos: tú declaras que pagaste.
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
        <button type="button" className="btn btn-primary" disabled={confirm.isPending} onClick={handleConfirm}>
          {confirm.isPending ? 'Confirmando…' : 'Confirmar'}
        </button>
      </div>
    </Modal>
  )
}
