import { useRef, useState } from 'react'
import { LoadingButton } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toasts'
import { ApiError, RequestTimeoutError, isNetworkError } from '../../lib/api/errors'
import { friendlyError } from '../../lib/api/messages'
import type { Obligation } from '../../lib/api/types'
import { getObligation } from './api'
import { useArchiveObligation } from './hooks'

/**
 * Confirmación del archivado manual. Archivar NO borra: la obligación deja de
 * generar períodos y no admite cambios, pero conserva períodos, documentos e
 * historial. Los períodos pendientes no cambian y siguen visibles.
 * Si la petición se corta (tiempo agotado o red) se consulta el estado real
 * antes de sugerir reintentar: pudo haberse archivado.
 */
export function ArchiveObligationModal({
  obligation,
  openCount,
  onClose,
}: {
  obligation: Obligation
  openCount: number
  onClose: () => void
}) {
  const archive = useArchiveObligation()
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  // Bloqueo síncrono: dos clics casi simultáneos no pueden enviar dos peticiones.
  const inFlight = useRef(false)

  async function confirm() {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    try {
      await archive.mutateAsync(obligation.id)
      toast.success('Obligación archivada correctamente.')
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Ya estaba archivada (otra pestaña o una propuesta aplicada): no es un fallo.
        toast.info('Esta obligación ya estaba archivada.')
        onClose()
        return
      }
      if (err instanceof RequestTimeoutError || isNetworkError(err)) {
        setChecking(true)
        try {
          const current = await getObligation(obligation.id)
          if (current.status === 'archived') {
            toast.success('Obligación archivada correctamente.')
            onClose()
            return
          }
          setError('No recibimos respuesta, pero la obligación sigue activa. Puedes volver a intentarlo.')
        } catch {
          setError(friendlyError(err, 'save') + ' No pudimos comprobar si se archivó: recarga la pantalla antes de reintentar.')
        } finally {
          setChecking(false)
        }
        return
      }
      setError(`No pudimos archivar la obligación. ${friendlyError(err, 'save')}`)
    } finally {
      inFlight.current = false
    }
  }

  const busy = archive.isPending || checking

  return (
    <Modal title="¿Quieres archivar esta obligación?" onClose={busy ? () => {} : onClose}>
      <p>
        <strong>{obligation.providerName}</strong> · {obligation.concept}
      </p>
      <p>
        Esta obligación dejará de estar activa y no generará nuevos períodos automáticamente. Conservaremos su historial para que puedas consultarlo cuando lo necesites.
      </p>
      {openCount > 0 && (
        <p role="note">
          Tiene <strong>{openCount}</strong> período{openCount === 1 ? '' : 's'} pendiente{openCount === 1 ? '' : 's'} o vencido{openCount === 1 ? '' : 's'}. No se anular{openCount === 1 ? 'á' : 'án'} ni se marcar{openCount === 1 ? 'á' : 'án'} como pagado{openCount === 1 ? '' : 's'}: seguirás viéndolo{openCount === 1 ? '' : 's'} en tus pendientes hasta que los resuelvas.
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <LoadingButton className="btn btn-danger" loading={busy} loadingText="Archivando…" onClick={confirm}>
          Archivar obligación
        </LoadingButton>
      </div>
    </Modal>
  )
}
