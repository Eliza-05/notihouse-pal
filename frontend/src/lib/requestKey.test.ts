import { describe, expect, it } from 'vitest'
import { createRequestKeeper } from './requestKey'

describe('clave de idempotencia por intento', () => {
  it('reintentar el mismo contenido reutiliza el identificador (no duplica tras un timeout)', () => {
    const k = createRequestKeeper()
    expect(k.for('agua 43 mil')).toBe(k.for('agua 43 mil'))
  })
  it('cambiar el contenido genera otro identificador', () => {
    const k = createRequestKeeper()
    expect(k.for('a')).not.toBe(k.for('b'))
  })
  it('tras confirmarse el envío, enviar lo mismo otra vez es una solicitud nueva', () => {
    const k = createRequestKeeper()
    const first = k.for('a')
    k.done()
    expect(k.for('a')).not.toBe(first)
  })
})
