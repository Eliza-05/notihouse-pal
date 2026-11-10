import type { DueItemKind } from './due-date.rules.js';

/**
 * Referencia de navegación de un recurso (misma forma que su ruta en la API).
 * El frontend la usa para abrir el detalle; nunca incluye datos sensibles.
 */
export function resourcePath(
  kind: DueItemKind,
  id: string,
  parentId: string | null,
): string {
  switch (kind) {
    case 'obligation_occurrence':
      return `/obligations/${parentId}/occurrences/${id}`;
    case 'rent_charge':
      return `/rentals/${parentId}/charges/${id}`;
    case 'contract':
      return `/contracts/${id}`;
    case 'hitl_request':
      return `/hitl-requests/${id}`;
  }
}
