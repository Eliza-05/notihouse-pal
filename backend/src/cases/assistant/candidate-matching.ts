/**
 * D17 (obligatorio): nunca se elige automáticamente entre varias
 * coincidencias. Cero candidatos → falta un dato; exactamente uno →
 * continúa; varios → se muestran las alternativas reales, nunca se decide.
 */
export type MatchResult<T> =
  | { kind: 'none' }
  | { kind: 'one'; candidate: T }
  | { kind: 'many'; candidates: T[] };

export function matchCandidates<T>(candidates: T[]): MatchResult<T> {
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'one', candidate: candidates[0]! };
  return { kind: 'many', candidates };
}
