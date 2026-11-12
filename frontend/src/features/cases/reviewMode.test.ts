import { describe, expect, it } from 'vitest'
import type { HitlDetail, Proposal } from '../../lib/api/types'
import { parseProposal } from './proposalSchema'
import { canApplyProposal, humanizeFieldKeys, reviewMode } from './reviewMode'

const proposal = (proposedData: unknown, over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1', caseId: 'c1', version: 2, source: 'llm', proposedData, evidence: null, confidence: null, documentId: null,
  reviewStatus: 'accepted', reviewedAt: null, reviewedBy: null, createdAt: '', updatedAt: '', ...over,
})
const hitl = (over: Partial<HitlDetail>): HitlDetail => ({
  id: 'h1', caseId: 'c1', proposalId: 'p1', decisionType: 'data_confirmation', status: 'approved', overdue: false,
  options: {}, decision: null, createdAt: '', dueAt: '', respondedAt: null, updatedAt: '', proposal: null, ...over,
})
const schedule = {
  action: 'update_obligation_schedule',
  data: { obligationId: 'o1', expected: { dueDay: 15 }, changes: { dueDay: 20 } },
}

describe('modo de revisión HITL', () => {
  it('propuesta con acción aplicable: se aprueba y luego se aplica', () => {
    const h = hitl({ proposal: proposal(schedule) })
    expect(reviewMode(h, parseProposal(schedule))).toBe('applicable')
    expect(canApplyProposal(h, parseProposal(schedule))).toBe(true)
  })
  it('informativa (requiere revisión manual): nunca "Aplicar"', () => {
    const raw = { requiereRevisionManual: true, camposProblematicos: ['valor'] }
    const h = hitl({ decisionType: 'other', proposal: proposal(raw) })
    expect(reviewMode(h, parseProposal(raw))).toBe('informational')
    expect(canApplyProposal(h, parseProposal(raw))).toBe(false)
  })
  it('guiada, transcripción de voz y sin propuesta: informativas', () => {
    const guided = { guided: { kind: 'x' } }
    expect(reviewMode(hitl({ proposal: proposal(guided) }), parseProposal(guided))).toBe('informational')
    expect(reviewMode(hitl({ proposal: null }), null)).toBe('informational')
    const stt = { transcript: 'hola' }
    const h = hitl({ proposal: proposal(stt, { source: 'stt' }) })
    expect(canApplyProposal(h, parseProposal(stt))).toBe(false)
  })
  it('con alternativas: modo elección y sin aplicación aunque la acción exista', () => {
    const h = hitl({ options: { choices: [{ key: 'a', label: 'A' }] }, proposal: proposal(schedule) })
    expect(reviewMode(h, parseProposal(schedule))).toBe('choice')
    expect(canApplyProposal(h, parseProposal(schedule))).toBe(false)
  })
  it('decisión distinta de data_confirmation o aún no aprobada: no se aplica', () => {
    const conflict = hitl({ decisionType: 'conflict_resolution', proposal: proposal(schedule) })
    expect(canApplyProposal(conflict, parseProposal(schedule))).toBe(false)
    const pending = hitl({ status: 'pending', proposal: proposal(schedule) })
    expect(canApplyProposal(pending, parseProposal(schedule))).toBe(false)
  })
  it('traduce claves técnicas a español', () => {
    expect(humanizeFieldKeys('Falta providerName y dueDay; expectedAmount no coincide')).toBe(
      'Falta proveedor y día de vencimiento; monto esperado no coincide',
    )
  })
})
