import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Upload } from 'lucide-react'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/StateBlocks'
import { ApiError } from '../../lib/api/errors'
import { formatInstant } from '../../lib/format/dates'
import { useDocuments, useUploadDocument } from './hooks'
import * as api from './api'

const MAX_SIZE = 10 * 1024 * 1024

export function DocumentsPage() {
  const { data, isLoading, isError, error, refetch } = useDocuments({ pageSize: 50 })
  const upload = useUploadDocument()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setUploadError(null)
    setNotice(null)
    if (file.type !== 'application/pdf') {
      setUploadError('Solo se admiten archivos PDF.')
      return
    }
    if (file.size > MAX_SIZE) {
      setUploadError('El archivo supera el tamaño permitido (10 MiB).')
      return
    }
    try {
      const res = await upload.mutateAsync({ file, requestId: crypto.randomUUID() })
      setNotice(res.duplicateContent ? 'Ya subiste este archivo antes. Se registró de todos modos.' : 'Factura recibida y en cola.')
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.messages.join(' ') : 'No se pudo subir el archivo.')
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleDownload(id: string, fileName: string | null) {
    try {
      await api.downloadDocument(id, fileName ?? 'documento.pdf')
    } catch {
      setUploadError('No se pudo descargar el archivo.')
    }
  }

  return (
    <div className="stack">
      <h1>Documentos</h1>
      <p className="text-muted">
        Subir una factura la almacena y la encola; no la lee ni la interpreta de inmediato. Sigue el progreso en Mis
        solicitudes.
      </p>

      <div
        className="card"
        style={{ borderStyle: 'dashed', textAlign: 'center', cursor: 'pointer' }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files[0]
          if (file) void handleFile(file)
        }}
      >
        <Upload size={28} style={{ marginBottom: '0.5rem' }} />
        <p>Arrastra una factura PDF aquí o haz clic para elegir el archivo</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleFile(file)
          }}
        />
        {upload.isPending && <p>Subiendo…</p>}
      </div>
      {uploadError && <p role="alert" className="field-error">{uploadError}</p>}
      {notice && <p role="status">{notice}</p>}

      {isLoading && <LoadingBlock label="Cargando documentos…" />}
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
                    <td>{d.type}</td>
                    <td>{d.source}</td>
                    <td>{formatInstant(d.createdAt)}</td>
                    <td className="row">
                      {d.caseId && <Link to={`/casos/${d.caseId}`}>Ver caso</Link>}
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
