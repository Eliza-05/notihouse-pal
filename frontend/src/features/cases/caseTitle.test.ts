import { describe, expect, it } from 'vitest'
import { caseTitle, isAssistantRequest, proposalAction } from './caseTitle'

const text = { type: 'household_obligation', source: 'form' } as const
const doc = { type: 'household_obligation', source: 'document' } as const

describe('título de la solicitud (solo presentación)', () => {
  it('una propuesta de arriendo no se rotula «Obligación del hogar»', () => {
    expect(caseTitle(text, 'create_recurring_rental')).toBe('Registro de arriendo')
    expect(caseTitle({ type: 'household_obligation', source: 'voice' }, 'create_recurring_rental')).toBe('Registro de arriendo')
  })
  it('sin propuesta aplicable, una solicitud al asistente usa una etiqueta genérica', () => {
    expect(caseTitle(text, null)).toBe('Solicitud al asistente')
    expect(isAssistantRequest(text)).toBe(true)
  })
  it('acciones sobre obligaciones y documentos/correo conservan «Obligación del hogar»', () => {
    expect(caseTitle(text, 'update_obligation_schedule')).toBe('Obligación del hogar')
    expect(caseTitle(text, 'archive_obligation')).toBe('Obligación del hogar')
    expect(caseTitle(doc, null)).toBe('Obligación del hogar')
    expect(isAssistantRequest(doc)).toBe(false)
  })
  it('otros tipos de caso no se tocan', () => {
    expect(caseTitle({ type: 'rent_collection', source: 'form' }, null)).toBe('Cobro de arriendo')
  })
  it('la acción sale de la última versión de la propuesta', () => {
    expect(proposalAction([])).toBeNull()
    expect(proposalAction(undefined)).toBeNull()
    expect(
      proposalAction([
        { version: 1, proposedData: { action: 'create_recurring_obligation' } },
        { version: 2, proposedData: { action: 'create_recurring_rental' } },
      ] as never),
    ).toBe('create_recurring_rental')
    expect(proposalAction([{ version: 1, proposedData: { resultado: 'needs_choice' } }] as never)).toBeNull()
  })
})
