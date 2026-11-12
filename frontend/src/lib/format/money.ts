import type { MoneyString } from '../api/types'

/**
 * El dinero viaja como texto decimal ("145000.00"): nunca convertir con
 * Number()/parseFloat para operar (§4, §11.3 de la guía). Esto solo formatea
 * para MOSTRAR; no se usa para cálculos y no redondea: trabaja sobre el texto.
 *
 * Presentación para Colombia: puntos de miles y coma decimal. Los centavos solo
 * se muestran cuando existen: "87400.00" → "$87.400"; "98500.50" → "$98.500,50".
 */
export function formatMoney(amount: MoneyString | null | undefined, currency: string | null | undefined = 'COP'): string {
  if (amount === null || amount === undefined || amount === '') return 'Sin monto'
  const [intPart, decRaw = ''] = amount.split('.')
  const withThousands = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const cents = decRaw.replace(/0+$/, '')
  const number = cents ? `${withThousands},${cents.padEnd(2, '0')}` : withThousands
  return !currency || currency === 'COP' ? `$${number}` : `${currency} ${number}`
}

/** «$87.400 COP»: el importe con su moneda al final (sin repetirla para otras monedas). */
export function formatMoneyWithCurrency(amount: MoneyString | null | undefined, currency: string | null | undefined = 'COP'): string {
  if (amount === null || amount === undefined || amount === '') return 'Sin monto'
  const code = currency || 'COP'
  const text = formatMoney(amount, code)
  return code === 'COP' ? `${text} COP` : text
}
