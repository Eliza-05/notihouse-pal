import { describe, expect, it } from 'vitest'
import type { Case, HitlRequest, Proposal } from '../../lib/api/types'
import { caseProgress, friendlyReason } from './caseProgress'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const base = (over: Partial<Case> = {}): Pick<Case, 'status' | 'source' | 'createdAt' | 'statusReason'> => ({
  status: 'processing', source: 'document', createdAt: '2026-11-11T11:59:30Z', statusReason: null, ...over,
})
const aseo = { action: 'create_obligation_with_occurrence', data: { obligation: { providerName: 'Aseo', concept: 'x', category: 'other' }, occurrence: { periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-12-22', amount: '87400.00' } } }
const prop = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1', caseId: 'c1', version: 1, source: 'llm', proposedData: aseo, evidence: null, confidence: null, documentId: 'd1',
  reviewStatus: 'accepted', reviewedAt: null, reviewedBy: null, createdAt: 't', updatedAt: 't', ...over,
})
const hitl = (status: HitlRequest['status']): HitlRequest => ({
  id: 'h1', caseId: 'c1', proposalId: 'p1', decisionType: 'data_confirmation', status, overdue: false, options: {}, decision: null,
  createdAt: '2026-11-11T11:00:00Z', dueAt: 't', respondedAt: null, updatedAt: 't',
})
const step = (p: ReturnType<typeof caseProgress>, key: string) => p.steps.find((s) => s.key === key)!

describe('progreso de la solicitud (solo estados respaldados por el backend)', () => {
  it('recibida: en cola, con indicador de actividad', () => {
    const p = caseProgress({ caseRow: base({ status: 'received' }), hitl: [], proposals: [], now: NOW })
    expect(p.headline).toBe('Recibimos tu factura')
    expect(p.busy).toBe(true)
    expect(step(p, 'analysis').state).toBe('waiting')
  })

  it('en proceso: «Estamos procesando tu factura», sin porcentaje ni tiempo restante inventado', () => {
    const p = caseProgress({ caseRow: base(), hitl: [], proposals: [], now: NOW })
    expect(p.headline).toBe('Estamos procesando tu factura')
    expect(step(p, 'analysis').state).toBe('active')
    expect(JSON.stringify(p)).not.toMatch(/%|casi termina|segundos restantes/i)
    expect(p.slow).toBe(false)
  })

  it('tarda más de lo habitual: avisa y ofrece seguir usando la app, sin prometer un tiempo', () => {
    const p = caseProgress({ caseRow: base({ createdAt: '2026-11-11T11:50:00Z' }), hitl: [], proposals: [], now: NOW })
    expect(p.slow).toBe(true)
    expect(p.slowNote).toMatch(/Puedes seguir usando NotiHouse-Pal/)
    expect(p.slowNote).not.toMatch(/casi/i)
  })

  it('esperando decisión: «La propuesta está lista para revisar»', () => {
    const p = caseProgress({ caseRow: base({ status: 'awaiting_human' }), hitl: [hitl('pending')], proposals: [prop({ reviewStatus: 'pending_review' })], now: NOW })
    expect(p.headline).toBe('La propuesta está lista para revisar')
    expect(step(p, 'review').state).toBe('active')
    expect(p.busy).toBe(false)
  })

  it('cerrado con propuesta aprobada pero SIN aplicar NO se presenta como completado', () => {
    const p = caseProgress({ caseRow: base({ status: 'completed' }), hitl: [hitl('approved')], proposals: [prop({ appliedAt: null })], now: NOW })
    expect(p.headline).toBe('Aprobada: falta aplicarla')
    expect(step(p, 'apply').state).toBe('active')
    expect(p.tone).toBe('warning')
  })

  it('cerrado y aplicado', () => {
    const p = caseProgress({ caseRow: base({ status: 'completed' }), hitl: [hitl('approved')], proposals: [prop({ appliedAt: '2026-11-11T17:33:26Z' })], now: NOW })
    expect(p.headline).toBe('Propuesta aplicada')
    expect(step(p, 'apply').state).toBe('done')
  })

  it('cerrado sin información de aplicación (backend anterior): «Revisión cerrada», sin afirmar que se aplicó', () => {
    const p = caseProgress({ caseRow: base({ status: 'completed' }), hitl: [hitl('approved')], proposals: [prop()], now: NOW })
    expect(p.headline).toBe('Revisión cerrada')
    expect(step(p, 'apply').state).toBe('waiting')
  })

  it('rechazada: no se registró nada', () => {
    const p = caseProgress({ caseRow: base({ status: 'completed' }), hitl: [hitl('rejected')], proposals: [prop({ reviewStatus: 'rejected' })], now: NOW })
    expect(p.headline).toMatch(/no se registró nada/)
    expect(step(p, 'apply').state).toBe('skipped')
  })

  it('fallida: explica en claro y detiene la actividad', () => {
    const p = caseProgress({ caseRow: base({ status: 'failed', statusReason: 'PERMANENTE: el PDF no tiene texto seleccionable; los documentos escaneados requieren OCR' }), hitl: [], proposals: [], now: NOW })
    expect(p.headline).toBe('No pudimos completar el análisis')
    expect(p.busy).toBe(false)
    expect(step(p, 'analysis').state).toBe('failed')
    expect(step(p, 'analysis').text).toMatch(/imagen escaneada/)
    expect(step(p, 'analysis').text).not.toMatch(/PERMANENTE|OCR/)
  })
})

describe('motivo de fallo legible', () => {
  it('quita prefijos técnicos y traduce los casos conocidos', () => {
    expect(friendlyReason(null)).toBe('No pudimos completar el análisis.')
    expect(friendlyReason('TEMPORAL: Gemini no devolvió un JSON válido')).not.toMatch(/TEMPORAL|JSON/)
    expect(friendlyReason('PERMANENTE: el audio no contiene voz inteligible')).toMatch(/voz/)
  })

  it('cada causa de fallo de IA se explica según el origen y sin tecnicismos', () => {
    const all = [
      friendlyReason('TEMPORAL: respuesta incompleta de Gemini', 'form'),
      friendlyReason('TEMPORAL: Gemini no devolvió un JSON válido', 'voice'),
      friendlyReason('TEMPORAL: Gemini respondió 503 Service Unavailable (modelo gemini-x)', 'form'),
      friendlyReason('TEMPORAL: n8n workflow timeout ECONNRESET', 'document'),
      friendlyReason('PERMANENTE: respuesta de resolución con un resultado desconocido', 'form'),
      friendlyReason('PERMANENTE: el audio supera el límite del envío directo a Gemini (', 'voice'),
      friendlyReason('TEMPORAL: cuota de Gemini agotada (429)', 'form'),
    ]
    for (const m of all) expect(m).not.toMatch(/gemini|json|n8n|workflow|econn|503|429|TEMPORAL|PERMANENTE|resolución/i)
    expect(friendlyReason('TEMPORAL: respuesta incompleta de Gemini', 'form')).toMatch(/interpretar el mensaje/)
    expect(friendlyReason('TEMPORAL: respuesta incompleta de Gemini', 'document')).toMatch(/interpretar el documento.*otro archivo/)
    expect(friendlyReason('TEMPORAL: Gemini respondió 503 Service Unavailable', 'form')).toMatch(/El asistente no está disponible en este momento/)
    expect(friendlyReason('PERMANENTE: el audio supera el límite del envío directo a Gemini (', 'voice')).toMatch(/nota más corta/)
    expect(friendlyReason('TEMPORAL: cuota de Gemini agotada (429)')).toMatch(/límite/)
    // Texto real que deja el backend al agotar los reintentos (verificado en QA): no debe mostrarse tal cual.
    const exhausted = friendlyReason('La automatización "text.interpret" falló de forma definitiva', 'form')
    expect(exhausted).not.toMatch(/automatizaci|text\.interpret|definitiva/i)
    expect(exhausted).toMatch(/No pudimos completar el análisis/)
  })
})
