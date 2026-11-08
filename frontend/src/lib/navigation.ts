/**
 * `resource.path` es una ruta de la API (p. ej. `/obligations/:id/occurrences/:id`),
 * no de React (§6.7, §8.7). Esto la traduce a una pantalla propia.
 */
export function resourcePathToRoute(path: string): string {
  const occurrence = /^\/obligations\/([^/]+)\/occurrences\/([^/]+)$/.exec(path)
  if (occurrence) return `/obligaciones/${occurrence[1]}`

  const charge = /^\/rentals\/([^/]+)\/charges\/([^/]+)$/.exec(path)
  if (charge) return `/arriendos/${charge[1]}`

  const contract = /^\/contracts\/([^/]+)$/.exec(path)
  if (contract) return '/contratos'

  const hitl = /^\/hitl-requests\/([^/]+)$/.exec(path)
  if (hitl) return `/revisiones/${hitl[1]}`

  return '/'
}
