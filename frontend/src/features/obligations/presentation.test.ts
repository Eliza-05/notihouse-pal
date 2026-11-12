import { describe, expect, it } from 'vitest'
import { isRecurring, listAmountText, obligationAmountRow, recurrenceText } from './presentation'

const once = { autoGenerate: false, expectedAmount: null, currency: 'COP', frequency: 'monthly' as const, dueDay: null }
const recurring = { autoGenerate: true, expectedAmount: '98500.00', currency: 'COP', frequency: 'monthly' as const, dueDay: 12 }
const occ = (amount: string | null, status = 'pending', dueDate = '2026-12-22') => ({ amount, currency: 'COP', status, dueDate }) as never

describe('importe de obligaciones únicas vs recurrentes', () => {
  it('única con un período: «Importe del período: $87.400 COP», nunca «Sin monto»', () => {
    const row = obligationAmountRow(once, [occ('87400.00')])
    expect(row.label).toBe('Importe del período')
    expect(row.value).toBe('$87.400 COP')
    expect(row.note).toMatch(/no se genera sola/)
    expect(JSON.stringify(row)).not.toMatch(/Sin monto/)
  })

  it('única con varios períodos: muestra el próximo por pagar', () => {
    const row = obligationAmountRow(once, [occ('50000.00', 'paid', '2026-10-22'), occ('87400.00', 'pending', '2026-12-22')])
    expect(row.label).toBe('Próximo período por pagar')
    expect(row.value).toBe('$87.400 COP')
  })

  it('única sin períodos o sin importes: lo dice, sin sugerir que no hay deuda', () => {
    expect(obligationAmountRow(once, []).value).toBe('Sin importe registrado')
    expect(obligationAmountRow(once, undefined).value).toBe('Cargando…')
  })

  it('recurrente: muestra el monto base y para qué sirve', () => {
    const row = obligationAmountRow(recurring, [])
    expect(row.label).toBe('Monto de cada período')
    expect(row.value).toBe('$98.500 COP')
    expect(row.note).toMatch(/próximos períodos/)
  })

  it('recurrente sin monto base: «Se define al registrar cada período»', () => {
    expect(obligationAmountRow({ ...recurring, expectedAmount: null }, []).value).toBe('Se define al registrar cada período')
  })

  it('la frecuencia «mensual» por defecto no engaña cuando no hay generación automática', () => {
    expect(recurrenceText(once)).toBe('Sin repetición automática')
    expect(recurrenceText(recurring)).toBe('Automática · mensual')
    expect(isRecurring(once)).toBe(false)
  })

  it('lista: remite a los períodos en lugar de «Sin monto»', () => {
    expect(listAmountText(once)).toEqual({ text: 'Según cada período', muted: true })
    expect(listAmountText(recurring)).toEqual({ text: '$98.500 COP', muted: false })
    expect(listAmountText({ ...recurring, expectedAmount: null }).text).toBe('Se define en cada período')
  })
})
