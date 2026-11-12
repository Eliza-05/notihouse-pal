import { describe, expect, it } from 'vitest'
import { applyCopEdit, formatCopInput, moneyToDisplay, normalizePasted, parseCop, pasteIntoCop, toWireMoney } from './cop'
import { moneyField, positiveMoneyField } from './validation'

describe('formato visible (miles con punto, coma decimal)', () => {
  it.each([
    ['55000', '55.000'],
    ['1200000', '1.200.000'],
    ['87400', '87.400'],
    ['15000000', '15.000.000'],
    ['55000,50', '55.000,50'],
    ['1250,5', '1.250,5'],
    ['1250,', '1.250,'],
    ['', ''],
    [',5', '0,5'],
    ['007', '7'],
    ['0', '0'],
    ['abc$ 12x', '12'],
    ['1.200.000', '1.200.000'],
    ['1.200.000,50', '1.200.000,50'],
    ['12,3,4', '12,34'],
  ])('%s → %s', (raw, shown) => {
    expect(formatCopInput(raw)).toBe(shown)
  })
})

describe('valor para el backend (sin Number ni redondeos)', () => {
  it.each([
    ['55.000', '55000.00'],
    ['1.200.000', '1200000.00'],
    ['87.400', '87400.00'],
    ['55.000,50', '55000.50'],
    ['1.250,5', '1250.50'],
    ['1.250,', '1250.00'],
    ['0', '0.00'],
    ['0,05', '0.05'],
    ['999.999.999.999,99', '999999999999.99'],
    ['', ''],
  ])('%s → %s', (shown, wire) => {
    expect(parseCop(shown)).toEqual({ ok: true, value: wire })
  })
  it('más de dos decimales, demasiadas cifras o texto inválido se rechazan, sin redondear', () => {
    expect(parseCop('10,123')).toEqual({ ok: false, error: 'decimals' })
    expect(parseCop('1.000.000.000.000')).toEqual({ ok: false, error: 'tooBig' })
    expect(parseCop('abc')).toEqual({ ok: false, error: 'invalid' })
    expect(parseCop(',')).toEqual({ ok: false, error: 'invalid' })
    expect(parseCop('-5')).toEqual({ ok: false, error: 'invalid' })
  })
  it('importes reales de los escenarios', () => {
    expect(toWireMoney('55.000')).toBe('55000.00') // Claro
    expect(toWireMoney('43.200')).toBe('43200.00') // Acueducto
    expect(toWireMoney('151.300')).toBe('151300.00') // Energía Solar
    expect(toWireMoney('1.200.000')).toBe('1200000.00') // Arriendo
    expect(toWireMoney('')).toBeUndefined() // vacío no es cero
  })
  it('el resultado cumple el patrón del backend', () => {
    const BACKEND = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/
    for (const s of ['55.000', '1.200.000,5', '0', '0,01', '999.999.999.999,99']) {
      const r = parseCop(s)
      expect(r.ok && BACKEND.test(r.value)).toBe(true)
    }
  })
})

describe('mostrar un monto existente', () => {
  it('quita ceros decimales innecesarios y conserva los reales', () => {
    expect(moneyToDisplay('55000.00')).toBe('55.000')
    expect(moneyToDisplay('55000.50')).toBe('55.000,5')
    expect(moneyToDisplay('1250.05')).toBe('1.250,05')
    expect(moneyToDisplay('1200000.00')).toBe('1.200.000')
    expect(moneyToDisplay(null)).toBe('')
    expect(moneyToDisplay('')).toBe('')
  })
  it('ida y vuelta sin perder valor', () => {
    for (const w of ['55000.00', '1200000.00', '999999999999.99', '0.05', '1250.50']) {
      expect(toWireMoney(moneyToDisplay(w))).toBe(w)
    }
  })
})

describe('edición con cursor', () => {
  it('escritura progresiva', () => {
    let v = ''
    for (const d of '1200000') {
      const e = applyCopEdit(v, v + d, v.length + 1, 'insertText')
      v = e.value
      expect(e.caret).toBe(v.length)
    }
    expect(v).toBe('1.200.000')
  })
  it('edición en medio: el cursor no salta al final', () => {
    // "1.200.000" con cursor tras el "2" (posición 3) y se teclea "5" → 1.2500.000 → 12.500.000
    const e = applyCopEdit('1.200.000', '1.25' + '00.000', 4, 'insertText')
    expect(e.value).toBe('12.500.000')
    expect(e.caret).toBe(4) // tras el "5": "12.5|00.000"
  })
  it('Backspace sobre un dígito', () => {
    const e = applyCopEdit('1.200.000', '1.20.000', 4, 'deleteContentBackward') // borró el 2.º cero del primer grupo? (posición 3→4)
    expect(e.value).toBe('120.000')
  })
  it('Backspace justo después de un punto borra el dígito contiguo (no se atasca)', () => {
    // "1.200" con cursor tras el punto (pos 2); Backspace borra el punto → raw "1200", cursor 1
    const e = applyCopEdit('1.200', '1200', 1, 'deleteContentBackward')
    expect(e.value).toBe('200')
  })
  it('Delete justo antes de un punto borra el dígito siguiente', () => {
    // "1.200" cursor tras el 1 (pos 1); Delete borra el punto → raw "1200", cursor 1
    const e = applyCopEdit('1.200', '1200', 1, 'deleteContentForward')
    expect(e.value).toBe('100')
    expect(e.caret).toBe(1)
  })
  it('reemplazar una selección', () => {
    // "1.200.000" con "200" seleccionado y se teclea "7" → "1.7.000"
    const e = applyCopEdit('1.200.000', '1.7.000', 3, 'insertText')
    expect(e.value).toBe('17.000')
  })
  it('un carácter no válido no cambia el valor', () => {
    const e = applyCopEdit('1.200', '1.200a', 6, 'insertText')
    expect(e.value).toBe('1.200')
    expect(e.caret).toBe(5)
  })
})

describe('pegado', () => {
  it('1200000 → 1.200.000', () => expect(pasteIntoCop('', 0, 0, '1200000').value).toBe('1.200.000'))
  it('1.200.000 no duplica separadores', () => expect(pasteIntoCop('', 0, 0, '1.200.000').value).toBe('1.200.000'))
  it('1.200.000,50 conserva los decimales', () => expect(pasteIntoCop('', 0, 0, '1.200.000,50').value).toBe('1.200.000,50'))
  it('$ 55.000 COP', () => expect(pasteIntoCop('', 0, 0, '$ 55.000 COP').value).toBe('55.000'))
  it('un valor del backend (55000.50) se entiende como decimal; 1.200 como miles', () => {
    expect(normalizePasted('55000.50')).toBe('55000,50')
    expect(pasteIntoCop('', 0, 0, '55000.50').value).toBe('55.000,50')
    expect(pasteIntoCop('', 0, 0, '1.200').value).toBe('1.200')
  })
  it('sustituye la selección', () => {
    expect(pasteIntoCop('9.999', 0, 5, '1200000').value).toBe('1.200.000')
  })
})

describe('esquemas de validación (mensajes en español)', () => {
  const msg = (schema: ReturnType<typeof moneyField>, v: string) => {
    const r = schema.safeParse(v)
    return r.success ? null : r.error.issues[0].message
  }
  it('opcional: vacío, entero y decimales son válidos', () => {
    const s = moneyField()
    for (const v of ['', '55.000', '55.000,5', '55.000,50', '0']) expect(msg(s, v)).toBeNull()
  })
  it('más de dos decimales y texto inválido', () => {
    expect(msg(moneyField(), '55.000,123')).toBe('Usa máximo 2 decimales, p. ej. 55.000,50')
    expect(msg(moneyField(), 'abc')).toMatch(/monto válido/)
  })
  it('positivo: rechaza cero y vacío obligatorio', () => {
    expect(msg(positiveMoneyField(), '0')).toBe('Debe ser mayor que cero')
    expect(msg(positiveMoneyField(), '0,00')).toBe('Debe ser mayor que cero')
    expect(msg(positiveMoneyField(), '')).toBe('Ingresa el monto')
    expect(msg(positiveMoneyField({ required: false }), '')).toBeNull()
    expect(msg(positiveMoneyField(), '1.200.000')).toBeNull()
  })
})
