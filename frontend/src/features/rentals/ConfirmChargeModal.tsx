import { useState } from 'react'
import { Modal } from '../../components/Modal'
import { ApiError } from '../../lib/api/errors'
import { useConfirmCharge } from './hooks'
import type { RentCharge } from '../../lib/api/types'

export function ConfirmChargeModal({
  rentalId,
  charge,
  onClose,
}: {
  rentalId: string
  charge: RentCharge
  onClose: () => void
}) {
  const [evidence, setEvidence] = useState('')
  const [error, setError] = useState<string | null>(null)
  const confirm = useConfirmCharge(rentalId)

  async function handleConfirm() {
    if (!evidence.trim()) {
      setError('La evidencia es obligatoria.')
      return
    }
    setError(null)
    try {
      await confirm.mutateAsync({ chargeId: charge.id, input: { evidence: evidence.trim() } })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.messages.join(' ') : 'No se pudo registrar la confirmación.')
    }
  }

  return (
    <Modal title="Confirmar recepción" onClose={onClose}>
      <p>Declaras que recibiste este pago. NotiHouse-Pal no realiza ni verifica pagos: tú declaras que lo recibiste.</p>
      <div className="field">
        <label htmlFor="evidence">Evidencia (obligatoria)</label>
        <textarea
          id="evidence"
          rows={3}
          maxLength={500}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="Recibido en efectivo el 5 de noviembre"
        />
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
