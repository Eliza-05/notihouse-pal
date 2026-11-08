/** Paginación de servidor (§4): nunca filtrar solo lo cargado en el cliente. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (totalPages <= 1) return null

  return (
    <nav className="row-between" aria-label="Paginación" style={{ marginTop: '0.75rem' }}>
      <span className="text-muted">
        Página {page} de {totalPages} · {total} resultado{total === 1 ? '' : 's'}
      </span>
      <div className="row">
        <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Anterior
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Siguiente
        </button>
      </div>
    </nav>
  )
}
