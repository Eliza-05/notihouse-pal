import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { caseHitlInterval, caseInterval, caseListInterval, invalidateAfterDecision } from './polling'
import { queryKey } from './queryKey'

describe('intervalos de polling', () => {
  it('caso: 5 s en proceso, 10 s esperando decisión, nada si es terminal o desconocido', () => {
    expect(caseInterval('received')).toBe(5_000)
    expect(caseInterval('processing')).toBe(5_000)
    expect(caseInterval('awaiting_human')).toBe(10_000)
    for (const s of ['completed', 'failed', 'cancelled']) expect(caseInterval(s)).toBe(false)
    expect(caseInterval(undefined)).toBe(false)
  })
  it('revisiones del caso: rápido hasta que exista una pendiente; nada en terminal', () => {
    expect(caseHitlInterval('processing', false)).toBe(5_000)
    expect(caseHitlInterval('awaiting_human', false)).toBe(5_000)
    expect(caseHitlInterval('awaiting_human', true)).toBe(10_000)
    expect(caseHitlInterval('completed', false)).toBe(false)
  })
  it('lista de casos: solo mientras haya alguno en curso', () => {
    expect(caseListInterval(['completed', 'failed'])).toBe(false)
    expect(caseListInterval(['completed', 'processing'])).toBe(15_000)
    expect(caseListInterval([])).toBe(false)
  })
})

describe('invalidación tras aprobar/aplicar', () => {
  it('invalida lista y detalle de obligaciones/períodos del usuario, y no toca a otro usuario', async () => {
    const qc = new QueryClient()
    const mine = [
      queryKey('u1', 'obligation', 'o1'),
      queryKey('u1', 'obligations', {}),
      queryKey('u1', 'occurrences', 'o1'),
      queryKey('u1', 'case', 'c1'),
      queryKey('u1', 'hitl', {}),
      queryKey('u1', 'attention', {}),
      queryKey('u1', 'dashboard'),
    ]
    const other = queryKey('u2', 'obligation', 'o1')
    for (const k of [...mine, other]) qc.setQueryData(k, { ok: true })
    await invalidateAfterDecision(qc, 'u1')
    for (const k of mine) expect(qc.getQueryState(k)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(other)?.isInvalidated).toBe(false)
  })
})

describe('respuestas fuera de orden', () => {
  it('una respuesta antigua que llega tarde no sobrescribe la nueva', async () => {
    const qc = new QueryClient()
    const resolvers: Array<(v: string) => void> = []
    const key = queryKey('u1', 'case', 'c1')
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: () => new Promise<string>((res) => resolvers.push(res)),
    })
    const unsub = observer.subscribe(() => {})
    await new Promise((r) => setTimeout(r, 0))
    resolvers[0]('inicial')
    await new Promise((r) => setTimeout(r, 0))
    resolvers.length = 0
    void qc.refetchQueries({ queryKey: key }) // petición A (vieja, p. ej. un tick de polling)
    await new Promise((r) => setTimeout(r, 0))
    expect(resolvers).toHaveLength(1)
    const refetch = qc.invalidateQueries({ queryKey: key }) // petición B (tras aprobar/aplicar) cancela y reemplaza a A
    await new Promise((r) => setTimeout(r, 0))
    expect(resolvers).toHaveLength(2)
    resolvers[1]('nuevo')
    await refetch
    resolvers[0]('viejo') // llega tarde
    await new Promise((r) => setTimeout(r, 0))
    expect(qc.getQueryData(key)).toBe('nuevo')
    unsub()
  })
})
