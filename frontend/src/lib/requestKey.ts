/**
 * Clave de idempotencia estable por intento de envío.
 *
 * El backend deduplica por `requestId`. Si la petición pudo registrarse pero el navegador no recibió la
 * respuesta (tiempo de espera, red caída), reintentar con un identificador NUEVO crearía un duplicado.
 * Este guardián conserva el mismo identificador mientras el contenido enviado sea el mismo y solo lo
 * renueva cuando el envío termina bien (`done`) o cuando cambia el contenido.
 */
export function createRequestKeeper() {
  let fingerprint: string | null = null
  let id: string | null = null
  return {
    /** Identificador para este contenido: el mismo en reintentos, uno nuevo si el contenido cambió. */
    for(content: string): string {
      if (id === null || fingerprint !== content) {
        fingerprint = content
        id = crypto.randomUUID()
      }
      return id
    },
    /** El envío se confirmó: el próximo contenido (aunque sea igual) es una solicitud nueva. */
    done(): void {
      fingerprint = null
      id = null
    },
  }
}
