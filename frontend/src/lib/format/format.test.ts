import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daysBetween, describeDueDate, formatCalendarDate, formatLongDate, formatPeriod, isPastDue } from './dates'
import { label } from './labels'
import { formatMoney, formatMoneyWithCurrency } from './money'

describe('dinero (texto decimal, sin Number())', () => {
  it('formatea COP con separador de miles colombiano y sin ",00" cuando son pesos exactos', () => {
    expect(formatMoney('145000.00', 'COP')).toBe('$145.000')
    expect(formatMoney('87400.00', 'COP')).toBe('$87.400')
    expect(formatMoney('98500.50', 'COP')).toBe('$98.500,50')
    expect(formatMoney('98500.5', 'COP')).toBe('$98.500,50')
    expect(formatMoney('1234567890.00', 'COP')).toBe('$1.234.567.890')
    expect(formatMoney('0.00', 'COP')).toBe('$0')
  })
  it('no pierde precisión con importes grandes', () => {
    expect(formatMoney('999999999999.99', 'COP')).toBe('$999.999.999.999,99')
  })
  it('monto nulo/vacío y otras monedas', () => {
    expect(formatMoney(null, 'COP')).toBe('Sin monto')
    expect(formatMoney('', 'COP')).toBe('Sin monto')
    expect(formatMoney('10.00', 'USD')).toBe('USD 10')
    expect(formatMoneyWithCurrency('87400.00', 'COP')).toBe('$87.400 COP')
    expect(formatMoneyWithCurrency('98500.50')).toBe('$98.500,50 COP')
    expect(formatMoneyWithCurrency('10.00', 'USD')).toBe('USD 10')
    expect(formatMoneyWithCurrency(null, 'COP')).toBe('Sin monto')
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

describe('fechas largas para textos explicativos', () => {
  it('«22 de diciembre de 2026», sin pasar por Date (sin desfase)', () => {
    expect(formatLongDate('2026-12-22')).toBe('22 de diciembre de 2026')
    expect(formatLongDate('2026-01-05')).toBe('5 de enero de 2026')
    expect(formatLongDate(null)).toBe('—')
    expect(formatLongDate('no-es-fecha')).toBe('no-es-fecha')
  })
  it('períodos: mismo mes o distintos meses', () => {
    expect(formatPeriod('2026-11-01', '2026-11-30')).toBe('1 al 30 de noviembre de 2026')
    expect(formatPeriod('2026-11-15', '2026-12-14')).toBe('15 de noviembre de 2026 al 14 de diciembre de 2026')
    expect(formatPeriod(null, '2026-11-30')).toBe('—')
  })
})

describe('etiquetas', () => {
  it('traduce estados conocidos y no rompe con valores desconocidos o nulos', () => {
    expect(label({ pending: 'Pendiente' }, 'pending')).toBe('Pendiente')
    expect(typeof label({ pending: 'Pendiente' }, 'otro_valor')).toBe('string')
    expect(typeof label({}, null)).toBe('string')
  })
})
