import { useState } from 'react'
import { LoadingButton } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toasts'
import { friendlyError } from '../../lib/api/messages'
import { formatMoneyWithCurrency } from '../../lib/format/money'
import { formatLongDate } from '../../lib/format/dates'
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
  const toast = useToast()

  async function handleConfirm() {
    if (!evidence.trim()) {
      setError('La evidencia es obligatoria.')
      return
    }
    setError(null)
    try {
      await confirm.mutateAsync({ chargeId: charge.id, input: { evidence: evidence.trim() } })
      toast.success('Declaraste el cobro como recibido.')
      onClose()
    } catch (err) {
      setError(friendlyError(err, 'save'))
    }
  }

  return (
    <Modal title="Confirmar cobro recibido" onClose={onClose}>
      <p>
        Cobro con vencimiento el {formatLongDate(charge.dueDate)} por <strong>{formatMoneyWithCurrency(charge.expectedAmount, charge.currency)}</strong>.
      </p>
      <p>
        Declaras que recibiste este pago. NotiHouse-Pal no realiza ni verifica pagos: es tu declaración. Después de confirmarlo, este cobro ya no se podrá editar desde la aplicación.
      </p>
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
        <LoadingButton loading={confirm.isPending} loadingText="Guardando…" onClick={handleConfirm}>
          Declarar como recibido
        </LoadingButton>
      </div>
    </Modal>
  )
}
