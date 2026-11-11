import { z } from 'zod'
import { copErrorMessage, isZeroMoney, parseCop } from './cop'

/** Mismo patrón que el backend (§4): decimal no negativo, hasta 2 decimales. */
export const MONEY_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/

/**
 * Montos de formulario: el campo guarda el TEXTO VISIBLE ("1.200.000,50", ver lib/format/cop.ts).
 * El valor para el backend ("1200000.50") se obtiene al enviar con `toWireMoney`.
 * Vacío es válido salvo que sea obligatorio (nunca se convierte en cero).
 */
function copBase(opts: { required: boolean; positive: boolean }) {
  return z.string().superRefine((text, ctx) => {
    const r = parseCop(text)
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: copErrorMessage(r.error) })
      return
    }
    if (r.value === '') {
      if (opts.required) ctx.addIssue({ code: 'custom', message: 'Ingresa el monto' })
      return
    }
    if (opts.positive && isZeroMoney(r.value)) ctx.addIssue({ code: 'custom', message: 'Debe ser mayor que cero' })
  })
}

/** Monto COP opcional (admite cero, como el backend para obligaciones/períodos). */
export const moneyField = (opts: { required?: boolean } = {}) => copBase({ required: !!opts.required, positive: false })

/** Monto COP mayor que cero (canon y cobros); opcional con `required: false`. */
export const positiveMoneyField = (opts: { required?: boolean } = {}) =>
  copBase({ required: opts.required ?? true, positive: true })

/** "YYYY-MM-DD", el mismo patrón que acepta `<input type="date">`. */
function calendarDateBase() {
  return z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ingresa una fecha válida')
}
function calendarDateOptional() {
  return calendarDateBase().optional().or(z.literal(''))
}

export function calendarDateField(opts: { required: true }): ReturnType<typeof calendarDateBase>
export function calendarDateField(opts?: { required?: boolean }): ReturnType<typeof calendarDateOptional>
export function calendarDateField(opts: { required?: boolean } = {}) {
  return opts.required ? calendarDateBase() : calendarDateOptional()
}
