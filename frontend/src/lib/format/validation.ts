import { z } from 'zod'

/** Mismo patrón que el backend (§4): decimal no negativo, hasta 2 decimales. */
export const MONEY_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/

function moneyBase() {
  return z.string().trim().regex(MONEY_PATTERN, 'Usa un monto válido, p. ej. 145000.00')
}
function moneyOptional() {
  return moneyBase().optional().or(z.literal(''))
}

export function moneyField(opts: { required: true }): ReturnType<typeof moneyBase>
export function moneyField(opts?: { required?: boolean }): ReturnType<typeof moneyOptional>
export function moneyField(opts: { required?: boolean } = {}) {
  return opts.required ? moneyBase() : moneyOptional()
}

export const positiveMoneyField = () =>
  z
    .string()
    .trim()
    .regex(MONEY_PATTERN, 'Usa un monto válido, p. ej. 145000.00')
    .refine((v) => Number(v) > 0, 'Debe ser mayor que cero')

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
