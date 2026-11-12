import { describe, expect, it } from 'vitest'
import type { HitlDetail, Proposal } from '../../lib/api/types'
import { parseProposal } from './proposalSchema'
import { reviewStage } from './reviewState'
import { humanizeText, reviewHeading } from './reviewSummary'

const proposedAseo = {
  action: 'create_obligation_with_occurrence',
  data: {
    obligation: { providerName: 'Aseo Verde de Prueba S.A.S.', concept: 'Servicio de aseo', category: 'other', currency: 'COP' },
    occurrence: { periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-22', amount: '87400.00' },
  },
}
const proposedRecurring = {
  action: 'create_recurring_obligation',
  data: { obligation: { providerName: 'ENS-1114', concept: 'Internet', category: 'internet', expectedAmount: '31000.00', dueDay: 28 } },
}

function proposal(data: unknown, extra: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1', caseId: 'c1', version: 1, source: 'llm', proposedData: data, evidence: null, confidence: null,
    documentId: 'd1', reviewStatus: 'accepted', reviewedAt: null, reviewedBy: null, createdAt: 't', updatedAt: 't', ...extra,
  }
}
function hitl(status: HitlDetail['status'], data: unknown, extra: Partial<Proposal> = {}, over: Partial<HitlDetail> = {}): HitlDetail {
  return {
    id: 'h1', caseId: 'c1', proposalId: 'p1', decisionType: 'data_confirmation', status, overdue: false, options: {}, decision: null,
    createdAt: 't', dueAt: 't', respondedAt: null, updatedAt: 't', proposal: proposal(data, extra), ...over,
  }
}
const stageOf = (h: HitlDetail, local = false) => reviewStage(h, h.proposal ? parseProposal(h.proposal.proposedData) : null, local).stage

describe('estado real de una revisión (aprobar ≠ aplicar)', () => {
  it('pendiente, vencida, rechazada y anulada', () => {
    expect(stageOf(hitl('pending', proposedAseo))).toBe('pending')
    expect(stageOf(hitl('pending', proposedAseo, {}, { overdue: true }))).toBe('expired')
    expect(stageOf(hitl('expired', proposedAseo))).toBe('expired')
    expect(stageOf(hitl('rejected', proposedAseo))).toBe('rejected')
    expect(stageOf(hitl('cancelled', proposedAseo))).toBe('cancelled')
  })

  it('aprobada: pendiente de aplicar solo si el backend afirma appliedAt = null', () => {
    expect(stageOf(hitl('approved', proposedAseo, { appliedAt: null }))).toBe('approved_pending_apply')
  })

  it('aprobada con appliedAt → aplicada', () => {
    expect(stageOf(hitl('approved', proposedAseo, { appliedAt: '2026-11-11T17:33:26Z' }))).toBe('applied')
  })

  it('aprobada sin dato de aplicación (backend anterior): no afirma ni aplicada ni pendiente', () => {
    expect(stageOf(hitl('approved', proposedAseo))).toBe('approved_apply_unknown')
  })

  it('una aplicación hecha en esta sesión cuenta como aplicada aunque el dato aún no llegue', () => {
    expect(stageOf(hitl('approved', proposedAseo), true)).toBe('applied')
  })

  it('informativa aprobada = «revisada», nunca «aplicada»; elección = «elección registrada»', () => {
    expect(stageOf(hitl('approved', { requiereRevisionManual: true }, {}, { decisionType: 'other' }))).toBe('acknowledged')
    expect(stageOf(hitl('approved', proposedAseo, {}, { options: { choices: [{ key: 'a', label: 'A' }] } }))).toBe('choice_recorded')
  })
})

describe('títulos que distinguen una revisión de otra', () => {
  const heading = (h: HitlDetail) => reviewHeading(h, parseProposal(h.proposal!.proposedData))

  it('factura: «Revisar factura de Aseo Verde… — $87.400»', () => {
    const h = heading(hitl('pending', proposedAseo))
    expect(h.title).toBe('Revisar factura de Aseo Verde de Prueba S.A.S. — $87.400')
    expect(h.description).toContain('22 de diciembre de 2026')
    expect(h.description).toContain('$87.400')
    expect(h.amount).toBe('87400.00')
  })

  it('obligación recurrente: «Confirmar obligación recurrente ENS-1114 — $31.000»', () => {
    expect(heading(hitl('pending', proposedRecurring)).title).toBe('Confirmar obligación recurrente ENS-1114 — $31.000')
  })

  it('dos revisiones del mismo tipo ya no se llaman igual', () => {
    expect(heading(hitl('pending', proposedAseo)).title).not.toBe(heading(hitl('pending', proposedRecurring)).title)
  })

  it('sin propuesta aplicable usa el resumen humanizado (sin claves técnicas ni ISO)', () => {
    const h = hitl('pending', { requiereRevisionManual: true }, {}, { decisionType: 'other', options: { summary: 'Falta providerName; vence 2026-12-22 por 87400.00' } })
    const out = reviewHeading(h, parseProposal(h.proposal!.proposedData))
    expect(out.description).toContain('proveedor')
    expect(out.description).toContain('22 de diciembre de 2026')
    expect(out.description).toContain('$87.400')
    expect(out.description).not.toContain('providerName')
  })
})

describe('humanizeText', () => {
  it('convierte importes con decimales y fechas ISO, y deja lo demás intacto', () => {
    expect(humanizeText('Registrar por 87400.00, vence 2026-12-22.')).toBe('Registrar por $87.400, vence 22 de diciembre de 2026.')
    expect(humanizeText('Día 28 de cada mes, 3 días antes')).toBe('Día 28 de cada mes, 3 días antes')
    expect(humanizeText('Versión 1.5 del contrato')).toBe('Versión 1.5 del contrato')
  })
})
