import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mic, Square, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { LoadingButton, Spinner } from '../../components/Feedback'
import { useToast } from '../../components/Toasts'
import { friendlyError } from '../../lib/api/messages'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import { useAudioRecorder } from '../../lib/useAudioRecorder'
import { uploadVoice } from './api'

function extensionFor(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('mpeg')) return 'mp3'
  return 'webm'
}

export function VoicePage() {
  const toast = useToast()
  const qc = useQueryClient()
  const { user } = useAuth()
  const recorder = useAudioRecorder()
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sentCaseId, setSentCaseId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function send(blob: Blob, mimeType: string) {
    setSending(true)
    setSendError(null)
    try {
      const res = await uploadVoice(blob, `nota.${extensionFor(mimeType)}`, crypto.randomUUID())
      setSentCaseId(res.caseId)
      recorder.reset()
      void qc.invalidateQueries({ queryKey: queryKey(user!.id, 'cases') })
      toast.success('Recibimos tu nota de voz.')
    } catch (err) {
      setSendError(friendlyError(err, 'upload'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="stack">
      <h1>Nota de voz</h1>
      <p className="text-muted">
        Se transcribirá y se te pedirá confirmar antes de registrar nada. Habla con calma: "Agua, 43 mil, vence el 20".
      </p>

      <div className="card" style={{ textAlign: 'center' }}>
        {recorder.status === 'idle' && (
          <button type="button" className="btn btn-primary" onClick={recorder.start}>
            <Mic size={18} /> Grabar
          </button>
        )}
        {recorder.status === 'recording' && (
          <div className="stack">
            <p>Grabando… {Math.floor(recorder.elapsedMs / 1000)}s</p>
            <button type="button" className="btn btn-danger" onClick={recorder.stop}>
              <Square size={16} /> Detener
            </button>
          </div>
        )}
        {recorder.status === 'recorded' && recorder.result && (
          <div className="stack">
            <audio controls src={recorder.result.url} />
            <div className="row" style={{ justifyContent: 'center' }}>
              <button type="button" className="btn btn-secondary" onClick={recorder.reset}>
                <Trash2 size={16} /> Regrabar
              </button>
              <LoadingButton loading={sending} loadingText="Enviando…" onClick={() => send(recorder.result!.blob, recorder.result!.mimeType)}>
                Enviar nota
              </LoadingButton>
            </div>
          </div>
        )}
        {recorder.status === 'error' && <p className="field-error">{recorder.errorMessage}</p>}

        <p className="text-muted" style={{ marginTop: '0.75rem' }}>
          O sube un archivo de audio en su lugar.
        </p>
        {sending && (
          <p role="status" className="row" style={{ justifyContent: 'center', alignItems: 'center', gap: '0.5rem' }}>
            <Spinner size={16} /> Enviando tu nota de voz…
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          aria-label="Subir un archivo de audio"
          accept="audio/*"
          style={{ maxWidth: '100%' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void send(file, file.type)
          }}
        />
      </div>

      {sendError && <p role="alert" className="field-error">{sendError}</p>}
      {sentCaseId && (
        <p role="status">
          Recibimos tu nota de voz y la estamos transcribiendo. Puedes seguir usando la aplicación. <Link to={`/casos/${sentCaseId}`}>Ver el avance</Link>
        </p>
      )}
    </div>
  )
}
