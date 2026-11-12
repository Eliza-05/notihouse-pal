import { describe, expect, it } from 'vitest'
import type { AttentionItem, HitlDetail, HitlRequest, Proposal } from '../../lib/api/types'
import { badgeCount, deriveNotifications, newToastCandidates, notificationKey } from './derive'

const aseo = { action: 'create_obligation_with_occurrence', data: { obligation: { providerName: 'Aseo Verde de Prueba S.A.S.', concept: 'Aseo', category: 'other', currency: 'COP' }, occurrence: { periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-22', amount: '87400.00' } } }
const recurring = { action: 'create_recurring_obligation', data: { obligation: { providerName: 'ENS-1114', concept: 'Internet', category: 'internet', expectedAmount: '31000.00', dueDay: 28 } } }

const request = (id: string, over: Partial<HitlRequest> = {}): HitlRequest => ({
  id, caseId: `c-${id}`, proposalId: `p-${id}`, decisionType: 'data_confirmation', status: 'pending', overdue: false, options: {}, decision: null,
  createdAt: '2026-11-11T17:28:21Z', dueAt: '2026-11-12T17:28:21Z', respondedAt: null, updatedAt: '2026-11-11T17:28:21Z', ...over,
})
const proposal = (id: string, data: unknown, over: Partial<Proposal> = {}): Proposal => ({
  id: `p-${id}`, caseId: `c-${id}`, version: 1, source: 'llm', proposedData: data, evidence: null, confidence: null, documentId: 'doc-1',
  reviewStatus: 'pending_review', reviewedAt: null, reviewedBy: null, createdAt: 't', updatedAt: 't', ...over,
})
const detail = (id: string, data: unknown, over: Partial<HitlDetail> = {}, pOver: Partial<Proposal> = {}): HitlDetail => ({ ...request(id), proposal: proposal(id, data, pOver), ...over })
const due = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: 'obligation_occurrence', id: 'occ1', title: 'servicio de agua — acueducto de prueba', description: 'Vence en 1 día', relevantDate: '2026-11-12', dueAt: null,
  status: 'pending', condition: 'upcoming', priority: 4, daysUntil: 1, amount: '43200.00', currency: 'COP', suggestedAction: 'confirm_payment',
  resource: { type: 'obligation_occurrence', id: 'occ1', path: '/obligations/o1/occurrences/occ1' }, alert: null, ...over,
})

describe('notificaciones relevantes', () => {
  it('factura pendiente de aprobación → aviso claro con proveedor e importe y acción hacia ESA revisión', () => {
    const [n] = deriveNotifications({ userId: 'camila', pending: [{ request: request('h-new'), detail: detail('h-new', aseo) }], approved: [], attention: [] })
    expect(n!.title).toBe('Tienes una factura por revisar')
    expect(n!.body).toBe('Recibimos una factura de Aseo Verde de Prueba S.A.S. por $87.400. Necesitamos tu aprobación para registrarla.')
    expect(n!.actionLabel).toBe('Revisar factura')
    expect(n!.to).toBe('/revisiones/h-new')
    expect(n!.priority).toBe('high')
    expect(n!.counts).toBe(true)
  })

  it('con dos revisiones, cada aviso lleva a su propia revisión (no a una antigua)', () => {
    const list = deriveNotifications({
      userId: 'camila',
      pending: [
        { request: request('h-old', { createdAt: '2026-11-11T04:19:13Z' }), detail: detail('h-old', recurring, { createdAt: '2026-11-11T04:19:13Z' }, { documentId: null }) },
        { request: request('h-new'), detail: detail('h-new', aseo) },
      ],
      approved: [],
      attention: [],
    })
    expect(list.map((n) => n.to)).toEqual(['/revisiones/h-new', '/revisiones/h-old'])
    expect(list[1]!.title).toBe('Tienes una propuesta por revisar')
    expect(list[1]!.body).toContain('$31.000')
  })

  it('sin detalle todavía: aviso provisional con la MISMA clave (no se vuelve a anunciar al enriquecerse)', () => {
    const base = { userId: 'u1', approved: [], attention: [] }
    const a = deriveNotifications({ ...base, pending: [{ request: request('h1') }] })
    const b = deriveNotifications({ ...base, pending: [{ request: request('h1'), detail: detail('h1', aseo) }] })
    expect(a[0]!.key).toBe(b[0]!.key)
    expect(a[0]!.title).toBe('Tienes una revisión por hacer')
  })

  it('aprobada y SIN aplicar (appliedAt null) avisa; si no hay dato o ya se aplicó, no afirma nada', () => {
    const mk = (pOver: Partial<Proposal>) => deriveNotifications({ userId: 'u1', pending: [], attention: [], approved: [detail('h1', aseo, { status: 'approved', respondedAt: '2026-11-11T17:33:13Z' }, { reviewStatus: 'accepted', ...pOver })] })
    expect(mk({ appliedAt: null })[0]?.title).toBe('Aprobaste una propuesta que falta aplicar')
    expect(mk({ appliedAt: null })[0]?.actionLabel).toBe('Aplicar')
    expect(mk({})).toEqual([]) // el backend no informa: no se inventa
    expect(mk({ appliedAt: '2026-11-11T17:33:26Z' })).toEqual([])
  })

  it('revisiones vencidas o ya resueltas no generan aviso de «por revisar»', () => {
    const list = deriveNotifications({
      userId: 'u1', approved: [], attention: [],
      pending: [{ request: request('a', { overdue: true }) }, { request: request('b', { status: 'approved' }) }],
    })
    expect(list).toEqual([])
  })

  it('vencimientos: vencido/hoy cuenta en la campana; «próximo» sin alerta se lista pero no cuenta', () => {
    const list = deriveNotifications({
      userId: 'u1', pending: [], approved: [],
      attention: [due({ id: 'a', condition: 'upcoming' }), due({ id: 'b', condition: 'overdue', description: 'Vencido hace 2 días' }), due({ id: 'c', condition: 'upcoming', alert: { id: 'al1', read: false } })],
    })
    expect(list.map((n) => [n.key.split(':')[2], n.counts])).toEqual([['b', true], ['c', true], ['a', false]])
    expect(badgeCount(list)).toBe(2)
    expect(list.find((n) => n.alertId === 'al1')).toBeTruthy()
    expect(list[0]!.body).toContain('$43.200')
    expect(list[0]!.to).toBe('/obligaciones/o1')
  })

  it('las revisiones de la Bandeja no se duplican como vencimientos', () => {
    const list = deriveNotifications({ userId: 'u1', pending: [], approved: [], attention: [due({ kind: 'hitl_request', id: 'h9', resource: { type: 'hitl_request', id: 'h9', path: '/hitl-requests/h9' } })] })
    expect(list).toEqual([])
  })

  it('claves estables por usuario, recurso y evento: sin duplicados aunque la fuente repita', () => {
    const d = detail('h1', aseo)
    const list = deriveNotifications({ userId: 'u1', pending: [{ request: request('h1'), detail: d }, { request: request('h1'), detail: d }], approved: [], attention: [] })
    expect(list).toHaveLength(1)
    expect(list[0]!.key).toBe(notificationKey('u1', 'hitl', 'h1', 'review_pending'))
    expect(notificationKey('daniel', 'hitl', 'h1', 'review_pending')).not.toBe(list[0]!.key)
  })

  it('«Sin pendientes»: lista vacía y contador 0', () => {
    const list = deriveNotifications({ userId: 'u1', pending: [], approved: [], attention: [] })
    expect(list).toEqual([])
    expect(badgeCount(list)).toBe(0)
  })
})

describe('qué merece un toast', () => {
  const high = deriveNotifications({ userId: 'u1', pending: [{ request: request('h1') }, { request: request('h2') }], approved: [], attention: [due()] })

  it('la primera carga es solo línea base: no anuncia los pendientes históricos', () => {
    expect(newToastCandidates(high, new Set(), false)).toEqual([])
  })

  it('después solo anuncia avisos de prioridad alta que no se hayan anunciado', () => {
    const announced = new Set([high[0]!.key])
    const out = newToastCandidates(high, announced, true)
    expect(out.map((n) => n.key)).toEqual([high[1]!.key])
    expect(out.every((n) => n.priority === 'high')).toBe(true) // los vencimientos no hacen toast
  })

  it('lo ya anunciado no se repite en el siguiente ciclo de polling', () => {
    const announced = new Set(high.map((n) => n.key))
    expect(newToastCandidates(high, announced, true)).toEqual([])
  })
})
