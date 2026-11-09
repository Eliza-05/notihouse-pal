import { Link } from 'react-router-dom'
import { EmptyBlock } from '../components/StateBlocks'

/** Ruta desconocida: mensaje claro en vez del error por defecto del enrutador. */
export function NotFoundPage() {
  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', padding: '0 16px' }}>
      <EmptyBlock
        title="Página no encontrada"
        description="La dirección que abriste no existe o ya no está disponible."
        action={<Link to="/" className="btn btn-primary">Ir al inicio</Link>}
      />
    </main>
  )
}
