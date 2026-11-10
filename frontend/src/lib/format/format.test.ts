import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daysBetween, describeDueDate, formatCalendarDate, isPastDue } from './dates'
import { label } from './labels'
import { formatMoney, formatMoneyWithCurrency } from './money'

describe('dinero (texto decimal, sin Number())', () => {
  it('formatea COP con separador de miles colombiano', () => {
    expect(formatMoney('145000.00', 'COP')).toBe('$145.000,00')
    expect(formatMoney('98500.50', 'COP')).toBe('$98.500,50')
    expect(formatMoney('1234567890.00', 'COP')).toBe('$1.234.567.890,00')
  })
  it('no pierde precisión con importes grandes', () => {
    expect(formatMoney('999999999999.99', 'COP')).toBe('$999.999.999.999,99')
  })
  it('monto nulo y otras monedas', () => {
    expect(formatMoney(null, 'COP')).toBe('Sin monto')
    expect(formatMoneyWithCurrency('10.00', 'USD')).toBe('USD 10,00 USD')
  })
})

describe('fechas de calendario (sin desfase por zona horaria)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 9, 12, 0, 0)) })
  afterEach(() => vi.useRealTimers())

  it('muestra el día correcto de una fecha YYYY-MM-DD', () => {
    expect(formatCalendarDate('2026-12-01')).toContain('1')
    expect(formatCalendarDate(null)).toBe('—')
  })
  it('daysBetween cruza meses, años bisiestos y no depende del horario de verano', () => {
    expect(daysBetween('2026-11-09', '2026-11-30')).toBe(21)
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
    expect(daysBetween('2026-11-09', '2026-11-01')).toBe(-8)
  })
  it('describe el vencimiento', () => {
    expect(describeDueDate('2026-11-09')).toBe('Vence hoy')
    expect(describeDueDate('2026-11-10')).toBe('Vence en 1 día')
    expect(describeDueDate('2026-11-12')).toBe('Vence en 3 días')
    expect(describeDueDate('2026-11-05')).toBe('Vencido hace 4 días')
    expect(isPastDue('2026-11-08')).toBe(true)
    expect(isPastDue('2026-11-09')).toBe(false)
  })
})

describe('etiquetas', () => {
  it('traduce estados conocidos y no rompe con valores desconocidos o nulos', () => {
    expect(label({ pending: 'Pendiente' }, 'pending')).toBe('Pendiente')
    expect(typeof label({ pending: 'Pendiente' }, 'otro_valor')).toBe('string')
    expect(typeof label({}, null)).toBe('string')
  })
})
