import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mic, Square, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { LoadingButton } from '../../components/Feedback'
import { useToast } from '../../components/Toasts'
import { friendlyError } from '../../lib/api/messages'
import { queryKey } from '../../lib/api/queryKey'
import { createRequestKeeper } from '../../lib/requestKey'
import { useAuth } from '../../lib/auth/useAuth'
import { useAudioRecorder } from '../../lib/useAudioRecorder'
import { uploadVoice } from '../voice/api'
import { sendTextIngestion } from './api'

const MAX_TEXT_LENGTH = 1000

function extensionFor(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('mpeg')) return 'mp3'
  return 'webm'
}

export function AssistantPage() {
  const [text, setText] = useState('')
  const [sendingText, setSendingText] = useState(false)
  const [textError, setTextError] = useState<string | null>(null)
  const [textCaseId, setTextCaseId] = useState<string | null>(null)

  const toast = useToast()
  const qc = useQueryClient()
  const { user } = useAuth()
  const refreshLists = () => {
    void qc.invalidateQueries({ queryKey: queryKey(user!.id, 'cases') })
    void qc.invalidateQueries({ queryKey: queryKey(user!.id, 'dashboard') })
  }

  const textKey = useRef(createRequestKeeper())
  const voiceKey = useRef(createRequestKeeper())
  const recorder = useAudioRecorder()
  const [sendingVoice, setSendingVoice] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceCaseId, setVoiceCaseId] = useState<string | null>(null)

  async function handleSendText() {
    const trimmed = text.trim()
    if (!trimmed) return
    setSendingText(true)
    setTextError(null)
    try {
      const res = await sendTextIngestion({ text: trimmed, requestId: textKey.current.for(trimmed) })
      textKey.current.done()
      setTextCaseId(res.caseId)
      setText('')
      refreshLists()
      toast.success('Recibimos tu mensaje.')
    } catch (err) {
      setTextError(friendlyError(err, 'upload'))
    } finally {
      setSendingText(false)
    }
  }

  async function handleSendVoice(blob: Blob, mimeType: string) {
    setSendingVoice(true)
    setVoiceError(null)
    try {
      const res = await uploadVoice(blob, `nota.${extensionFor(mimeType)}`, voiceKey.current.for(`${blob.size}:${blob.type}`))
      voiceKey.current.done()
      setVoiceCaseId(res.caseId)
      recorder.reset()
      refreshLists()
      toast.success('Recibimos tu nota de voz.')
    } catch (err) {
      setVoiceError(friendlyError(err, 'upload'))
    } finally {
      setSendingVoice(false)
    }
  }

  return (
    <div className="stack">
      <h1>Asistente</h1>
      <p className="text-muted">
        Escribe o grábate contando qué pasó — por ejemplo "Agua, 43 mil, vence el 20". Se te pedirá confirmar antes de
        registrar nada. NotiHouse-Pal no envía mensajes ni pagos por ti.
      </p>

      <div className="card">
        <h2 className="card-title">Escribir</h2>
        <div className="field">
          <label htmlFor="assistant-text">Mensaje</label>
          <textarea
            id="assistant-text"
            rows={3}
            maxLength={MAX_TEXT_LENGTH}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Cuéntame qué obligación, cobro o contrato quieres registrar o actualizar"
          />
          <div className="text-muted" style={{ textAlign: 'right', fontSize: '0.8rem' }}>
            {text.length}/{MAX_TEXT_LENGTH}
          </div>
        </div>
        {textError && <p role="alert" className="field-error">{textError}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <LoadingButton loading={sendingText} loadingText="Enviando…" disabled={!text.trim()} onClick={handleSendText}>
            Enviar mensaje
          </LoadingButton>
        </div>
        {textCaseId && (
          <p role="status">
            Recibimos tu mensaje y lo estamos analizando. Puedes seguir usando la aplicación. <Link to={`/casos/${textCaseId}`}>Ver el avance</Link>
          </p>
        )}
      </div>

      <div className="card" style={{ textAlign: 'center' }}>
        <h2 className="card-title">Grabar nota de voz</h2>
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
              <LoadingButton loading={sendingVoice} loadingText="Enviando…" onClick={() => handleSendVoice(recorder.result!.blob, recorder.result!.mimeType)}>
                Enviar nota
              </LoadingButton>
            </div>
          </div>
        )}
        {recorder.status === 'error' && <p className="field-error">{recorder.errorMessage}</p>}
        {voiceError && <p role="alert" className="field-error">{voiceError}</p>}
        {voiceCaseId && (
          <p role="status">
            Recibimos tu nota de voz y la estamos transcribiendo. Puedes seguir usando la aplicación. <Link to={`/casos/${voiceCaseId}`}>Ver el avance</Link>
          </p>
        )}
      </div>

      <p className="text-muted">
        <Link to="/casos">Ver mis solicitudes</Link> para seguir el estado de todo lo que has enviado.
      </p>
    </div>
  )
}
