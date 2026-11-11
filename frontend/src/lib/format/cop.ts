/**
 * Montos en pesos colombianos para formularios: puntos de miles, coma decimal.
 *
 * - La VISUALIZACIÓN ("1.200.000,50") está separada del valor enviado al backend
 *   ("1200000.50", mismo patrón que `MONEY_PATTERN` del backend).
 * - Todo es manipulación de texto: nunca Number()/parseFloat() ni redondeos, así
 *   que no se pierden dígitos en importes grandes (§4, §11.3 de la guía).
 * - En el campo los puntos son SIEMPRE separadores de miles, nunca decimales.
 */

export const COP_MAX_INT_DIGITS = 12 // igual que el backend: ^(0|[1-9]\d{0,11})
export const COP_MAX_DECIMALS = 2

/** Deja solo dígitos y, como máximo, la primera coma. Ignora puntos, espacios, letras y símbolos. */
export function sanitizeCop(raw: string): string {
  let out = ''
  let comma = false
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch
    else if (ch === ',' && !comma) {
      out += ','
      comma = true
    }
  }
  return out
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** Texto ya saneado → texto visible. "1200000,5" → "1.200.000,5"; "" → ""; ",5" → "0,5". */
export function formatCop(sanitized: string): string {
  if (sanitized === '') return ''
  const [intRaw, dec] = sanitized.split(',')
  const hasComma = sanitized.includes(',')
  let int = intRaw.replace(/^0+(?=\d)/, '')
  if (int === '') int = '0'
  return group(int) + (hasComma ? ',' + (dec ?? '') : '')
}

/** Lo que escribe/pega la persona → texto visible. */
export function formatCopInput(raw: string): string {
  return formatCop(sanitizeCop(raw))
}

export type CopParse =
  | { ok: true; value: string } // '' si el campo está vacío; si no, "1200000.50"
  | { ok: false; error: 'invalid' | 'decimals' | 'tooBig' }

/** Texto visible → valor para el backend, sin Number(). */
export function parseCop(display: string): CopParse {
  const text = display.trim()
  if (text === '') return { ok: true, value: '' }
  if (!/^[\d.]*(,\d*)?$/.test(text) || !/\d/.test(text)) return { ok: false, error: 'invalid' }
  const [intRaw, dec = ''] = text.split(',')
  const int = intRaw.replace(/\./g, '').replace(/^0+(?=\d)/, '')
  if (int === '' ) return { ok: false, error: 'invalid' }
  if (dec.length > COP_MAX_DECIMALS) return { ok: false, error: 'decimals' }
  if (int.length > COP_MAX_INT_DIGITS) return { ok: false, error: 'tooBig' }
  return { ok: true, value: `${int}.${dec.padEnd(2, '0')}` }
}

export function isZeroMoney(wire: string): boolean {
  return /^0\.0+$/.test(wire)
}

/** Valor del backend ("55000.00", "55000.50", null) → texto para el campo ("55.000", "55.000,50", ""). */
export function moneyToDisplay(wire: string | null | undefined): string {
  if (!wire) return ''
  const [int, dec = ''] = wire.split('.')
  const cents = dec.replace(/0+$/, '')
  return formatCop(int + (cents ? ',' + cents : ''))
}

/** Valor para enviar: '' → undefined (campo vacío no es cero). Asume que el esquema ya validó. */
export function toWireMoney(display: string): string | undefined {
  const r = parseCop(display)
  return r.ok && r.value !== '' ? r.value : undefined
}

export function copErrorMessage(error: 'invalid' | 'decimals' | 'tooBig'): string {
  switch (error) {
    case 'decimals':
      return 'Usa máximo 2 decimales, p. ej. 55.000,50'
    case 'tooBig':
      return 'El monto es demasiado grande (máximo 12 cifras enteras)'
    default:
      return 'Escribe un monto válido, p. ej. 55.000 o 55.000,50'
  }
}

/** Posición del cursor tras `k` caracteres significativos (dígitos o coma) dentro del texto formateado. */
function caretAfterSignificant(formatted: string, k: number): number {
  if (k <= 0) return 0
  let seen = 0
  for (let i = 0; i < formatted.length; i++) {
    if (formatted[i] !== '.') {
      seen++
      if (seen === k) return i + 1
    }
  }
  return formatted.length
}

function countSignificantBefore(raw: string, caret: number): number {
  let n = 0
  let comma = false
  for (let i = 0; i < Math.min(caret, raw.length); i++) {
    const ch = raw[i]
    if ((ch >= '0' && ch <= '9') || (ch === ',' && !comma)) {
      n++
      if (ch === ',') comma = true
    }
  }
  return n
}

export interface CopEdit {
  value: string
  caret: number
}

/**
 * Procesa un cambio del <input>: `raw` es el texto ya modificado por el navegador,
 * `caret` la posición del cursor tras el cambio y `prev` el texto anterior.
 * Devuelve el texto formateado y dónde dejar el cursor (sin saltar al final).
 * Si Backspace/Delete solo borró un punto de miles, borra el dígito contiguo
 * para que la tecla no quede "atascada".
 */
export function applyCopEdit(prev: string, raw: string, caret: number, inputType?: string): CopEdit {
  let text = raw
  let pos = caret
  if (sanitizeCop(raw) === sanitizeCop(prev) && raw.length < prev.length) {
    if (inputType === 'deleteContentBackward' && pos > 0) {
      text = raw.slice(0, pos - 1) + raw.slice(pos)
      pos -= 1
    } else if (inputType === 'deleteContentForward' && pos < raw.length) {
      text = raw.slice(0, pos) + raw.slice(pos + 1)
    }
  }
  const sanitized = sanitizeCop(text)
  const value = formatCop(sanitized)
  const k = countSignificantBefore(text, pos)
  return { value, caret: caretAfterSignificant(value, k) }
}

/** Texto pegado: "1.200.000,50" y "1200000" se respetan; "55000.50" (un punto y 1–2 dígitos) es decimal del backend. */
export function normalizePasted(text: string): string {
  const t = text.trim().replace(/^\$\s*/, '').replace(/\s*(COP)?$/i, '')
  if (/^\d+\.\d{1,2}$/.test(t)) return t.replace('.', ',')
  return t
}

/** Inserta lo pegado en la selección [start, end) del texto actual. */
export function pasteIntoCop(current: string, start: number, end: number, pasted: string): CopEdit {
  const insert = normalizePasted(pasted)
  const text = current.slice(0, start) + insert + current.slice(end)
  const pos = start + insert.length
  const sanitized = sanitizeCop(text)
  const value = formatCop(sanitized)
  return { value, caret: caretAfterSignificant(value, countSignificantBefore(text, pos)) }
}
