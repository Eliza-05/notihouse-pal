import type { MoneyString } from '../api/types'

/**
 * El dinero viaja como texto decimal ("145000.00"): nunca convertir con
 * Number()/parseFloat para operar (§4, §11.3 de la guía). Esto solo formatea
 * para MOSTRAR; no se usa para cálculos.
 */
export function formatMoney(amount: MoneyString | null, currency: string): string {
  if (amount === null) return 'Sin monto'
  const [intPart, decPart = '00'] = amount.split('.')
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const symbol = currency === 'COP' ? '$' : `${currency} `
  return `${symbol}${withThousands},${decPart}`
}

export function formatMoneyWithCurrency(amount: MoneyString | null, currency: string): string {
  if (amount === null) return 'Sin monto'
  return `${formatMoney(amount, currency)} ${currency}`
}
