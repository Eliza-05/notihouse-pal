import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, FileText, Upload } from 'lucide-react'
import { EmptyBlock, ErrorBlock } from '../../components/StateBlocks'
import { SkeletonTable, Spinner } from '../../components/Feedback'
import { useToast } from '../../components/Toasts'
import { friendlyError } from '../../lib/api/messages'
import { createRequestKeeper } from '../../lib/requestKey'
import { DOCUMENT_SOURCE_LABELS, DOCUMENT_TYPE_LABELS, label } from '../../lib/format/labels'
import { formatInstant } from '../../lib/format/dates'
import { useDocuments, useUploadDocument } from './hooks'
import * as api from './api'

const MAX_SIZE = 10 * 1024 * 1024

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

export function DocumentsPage() {
  const { data, isLoading, isError, error, refetch } = useDocuments({ pageSize: 50 })
  const upload = useUploadDocument()
  const [uploadError, setUploadError] = useState<string | null>(null)
  // Archivo elegido y validado, pendiente de confirmar: no sale del navegador hasta «Enviar documento».
  const [selected, setSelected] = useState<File | null>(null)
  const [received, setReceived] = useState<{ caseId: string; duplicate: boolean; fileName: string } | null>(null)
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const uploadKey = useRef(createRequestKeeper())

  /** Valida y deja el archivo en espera de confirmación. Reemplaza (descarta) cualquier selección anterior. */
  function selectFile(file: File) {
    if (upload.isPending) return // sin cambios de archivo mientras hay una subida en curso
    setUploadError(null)
    setReceived(null)
    setSelected(null)
    if (inputRef.current) inputRef.current.value = ''
    if (file.type !== 'application/pdf') {
      setUploadError('Solo se admiten facturas en PDF. Elige un archivo con extensión .pdf.')
      return
    }
    if (file.size === 0) {
      setUploadError('Ese archivo está vacío. Elige otro PDF.')
      return
    }
    if (file.size > MAX_SIZE) {
      setUploadError('El archivo es demasiado grande (máximo 10 MB). Prueba con uno más liviano.')
      return
    }
    setSelected(file)
  }

  function previewSelected() {
    if (!selected) return
    try {
      const url = URL.createObjectURL(selected)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      setUploadError('No pudimos abrir la vista previa. Puedes enviar el documento de todos modos.')
    }
  }

  async function confirmUpload() {
    const file = selected
    if (!file || upload.isPending) return // sin dobles envíos mientras hay una subida en curso
    setUploadError(null)
    try {
      const res = await upload.mutateAsync({ file, requestId: uploadKey.current.for(`${file.name}:${file.size}:${file.lastModified}`) })
      uploadKey.current.done()
      setSelected(null)
      setReceived({ caseId: res.caseId, duplicate: res.duplicateContent, fileName: file.name })
      toast.success('Recibimos tu documento.')
    } catch (err) {
      // El archivo sigue seleccionado: se puede reintentar (misma clave de idempotencia) o elegir otro.
      setUploadError(friendlyError(err, 'upload'))
    }
  }

  async function handleDownload(id: string, fileName: string | null) {
    try {
      await api.downloadDocument(id, fileName ?? 'documento.pdf')
    } catch (err) {
      setUploadError(friendlyError(err, 'load'))
    }
  }

  return (
    <div className="stack">
      <h1>Documentos</h1>
      <p className="text-muted">
        Al subir una factura la guardamos y la analizamos en segundo plano. Puedes seguir usando NotiHouse-Pal: el avance y el
        resultado aparecen en Mis solicitudes.
      </p>

      <input
        ref={inputRef}
        type="file"
        aria-label="Elegir factura PDF"
        accept="application/pdf"
        className="visually-hidden"
        tabIndex={-1}
        disabled={upload.isPending}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) selectFile(file)
        }}
      />
      {!selected && (
        <div
          className="card"
          style={{ borderStyle: 'dashed', textAlign: 'center', cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          aria-label="Subir factura PDF: arrastra un archivo aquí o presiona Enter para elegirlo"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files[0]
            if (file) selectFile(file)
          }}
        >
          <Upload size={28} style={{ marginBottom: '0.5rem' }} />
          <p>Arrastra una factura PDF aquí o haz clic para elegir el archivo</p>
          <p className="text-muted" style={{ marginBottom: 0 }}>Antes de enviarla podrás revisar el archivo.</p>
        </div>
      )}
      {selected && (
        <div className="card stack" aria-busy={upload.isPending || undefined} aria-label="Archivo seleccionado" role="group">
          <div className="row" style={{ alignItems: 'center', gap: '0.75rem' }}>
            <FileText size={32} aria-hidden="true" />
            <div style={{ minWidth: 0 }}>
              <strong style={{ overflowWrap: 'anywhere' }}>{selected.name}</strong>
              <div className="text-muted">PDF · {formatSize(selected.size)}</div>
            </div>
          </div>
          <p className="text-muted" style={{ margin: 0 }}>
            Revisa que sea el archivo correcto. No se envía hasta que lo confirmes.
          </p>
          {upload.isPending && (
            <p role="status" className="row" style={{ alignItems: 'center', gap: '0.5rem', margin: 0 }}>
              <Spinner size={16} /> Enviando tu factura…
            </p>
          )}
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={upload.isPending} onClick={() => void confirmUpload()}>
              Enviar documento
            </button>
            <button type="button" className="btn btn-secondary" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
              Elegir otro archivo
            </button>
            <button type="button" className="btn btn-secondary" disabled={upload.isPending} onClick={previewSelected}>
              <Eye size={16} aria-hidden="true" /> Ver vista previa
            </button>
          </div>
        </div>
      )}
      {uploadError && <p role="alert" className="field-error">{uploadError}</p>}
      {received && (
        <div className="card" role="status">
          <p style={{ marginTop: 0 }}>
            <strong>Recibimos «{received.fileName}».</strong> Estamos procesando tu factura; puedes seguir usando la aplicación.
          </p>
          {received.duplicate && (
            <p className="text-muted">
              Este mismo archivo ya se había subido antes. Lo registramos como una solicitud nueva: al revisar la propuesta verifica que no estés duplicando una factura.
            </p>
          )}
          <Link to={`/casos/${received.caseId}`} className="btn btn-secondary btn-sm">
            Ver el avance
          </Link>
        </div>
      )}

      {isLoading && <SkeletonTable rows={4} cols={5} label="Cargando documentos…" />}
      {isError && <ErrorBlock error={error} onRetry={refetch} />}
      {!isLoading && !isError && data && data.items.length === 0 && <EmptyBlock title="Aún no has subido facturas" />}
      {!isLoading && !isError && data && data.items.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Archivo</th>
                  <th>Tipo</th>
                  <th>Origen</th>
                  <th>Fecha</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((d) => (
                  <tr key={d.id}>
                    <td>{d.fileName ?? d.id}</td>
                    <td>{label(DOCUMENT_TYPE_LABELS, d.type)}</td>
                    <td>{label(DOCUMENT_SOURCE_LABELS, d.source)}</td>
                    <td>{formatInstant(d.createdAt)}</td>
                    <td className="row">
                      {d.caseId && <Link to={`/casos/${d.caseId}`}>Ver solicitud</Link>}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleDownload(d.id, d.fileName)}>
                        Descargar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
