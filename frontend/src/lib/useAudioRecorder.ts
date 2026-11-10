import { useCallback, useRef, useState } from 'react'

const MAX_DURATION_MS = 2 * 60_000
const MAX_SIZE_BYTES = 13 * 1024 * 1024

export interface RecordedAudio {
  blob: Blob
  url: string
  mimeType: string
  durationMs: number
}

/**
 * Grabación de notas de voz en el navegador (§10.8 de la guía): pide permiso
 * tras el gesto del usuario, límite ~2 min y ≤13 MiB (lo que procesan los
 * workflows de voz). Comparte la lógica el asistente y la pantalla de voz.
 */
export function useAudioRecorder() {
  const [status, setStatus] = useState<'idle' | 'recording' | 'recorded' | 'error'>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [result, setResult] = useState<RecordedAudio | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const supported = typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }, [])

  const start = useCallback(async () => {
    setErrorMessage(null)
    setResult(null)
    if (!supported) {
      setStatus('error')
      setErrorMessage('Tu navegador no admite grabación de audio. Puedes subir un archivo.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stopTimer()
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
        if (blob.size > MAX_SIZE_BYTES) {
          setStatus('error')
          setErrorMessage('La grabación supera el tamaño permitido. Intenta un mensaje más corto.')
          return
        }
        const url = URL.createObjectURL(blob)
        setResult({ blob, url, mimeType: recorder.mimeType, durationMs: Date.now() - startRef.current })
        setStatus('recorded')
      }
      recorderRef.current = recorder
      startRef.current = Date.now()
      recorder.start()
      setStatus('recording')
      setElapsedMs(0)
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startRef.current
        setElapsedMs(elapsed)
        if (elapsed >= MAX_DURATION_MS) recorder.stop()
      }, 200)
    } catch {
      setStatus('error')
      setErrorMessage('No se pudo acceder al micrófono. Revisa los permisos del navegador.')
    }
  }, [stopTimer, supported])

  const stop = useCallback(() => {
    recorderRef.current?.stop()
  }, [])

  const reset = useCallback(() => {
    if (result) URL.revokeObjectURL(result.url)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    stopTimer()
    setResult(null)
    setStatus('idle')
    setElapsedMs(0)
    setErrorMessage(null)
  }, [result, stopTimer])

  return { status, elapsedMs, result, errorMessage, supported, start, stop, reset }
}
