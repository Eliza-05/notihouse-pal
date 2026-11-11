// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MoneyInput } from './MoneyInput'

afterEach(cleanup)

function Harness({ initial = '', spy }: { initial?: string; spy?: (v: string) => void }) {
  const [v, setV] = useState(initial)
  return (
    <MoneyInput
      aria-label="monto"
      value={v}
      onChange={(n) => {
        setV(n)
        spy?.(n)
      }}
    />
  )
}
const box = () => screen.getByLabelText('monto') as HTMLInputElement

describe('MoneyInput controlado (React)', () => {
  it('escritura progresiva con separadores de miles', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), '1200000')
    expect(box().value).toBe('1.200.000')
    expect(box().selectionStart).toBe(9)
  })

  it('decimales con coma y límite visual al validar (no se pierden dígitos)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), '55000,50')
    expect(box().value).toBe('55.000,50')
  })

  it('rechaza letras y símbolos', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), '12ab$3')
    expect(box().value).toBe('123')
  })

  it('edición en medio: el cursor se queda donde se escribe', async () => {
    const user = userEvent.setup()
    render(<Harness initial="1.200.000" />)
    box().focus()
    box().setSelectionRange(4, 4) // tras "1.20"
    await user.keyboard('5')
    expect(box().value).toBe('12.050.000')
    expect(box().selectionStart).toBe(5) // tras el "5": "12.05|0.000"
  })

  it('Backspace borra dígitos y no se atasca en los puntos', async () => {
    const user = userEvent.setup()
    render(<Harness initial="1.200.000" />)
    box().focus()
    box().setSelectionRange(2, 2) // justo después del primer punto
    await user.keyboard('{Backspace}')
    expect(box().value).toBe('200.000')
    await user.keyboard('{Backspace}')
    expect(box().value).toBe('200.000') // cursor al inicio: nada que borrar
  })

  it('Delete borra el dígito siguiente', async () => {
    const user = userEvent.setup()
    render(<Harness initial="1.200.000" />)
    box().focus()
    box().setSelectionRange(0, 0)
    await user.keyboard('{Delete}')
    expect(box().value).toBe('200.000')
  })

  it('seleccionar y reemplazar', async () => {
    const user = userEvent.setup()
    render(<Harness initial="1.200.000" />)
    box().focus()
    box().setSelectionRange(0, 9)
    await user.keyboard('87400')
    expect(box().value).toBe('87.400')
  })

  it('pegado: 1200000, 1.200.000 y 1.200.000,50', async () => {
    const user = userEvent.setup()
    for (const [pasted, shown] of [
      ['1200000', '1.200.000'],
      ['1.200.000', '1.200.000'],
      ['1.200.000,50', '1.200.000,50'],
    ]) {
      const { unmount } = render(<Harness />)
      box().focus()
      await user.paste(pasted)
      expect(box().value).toBe(shown)
      unmount()
    }
  })

  it('campo vacío sigue vacío (no se convierte en cero) y se puede corregir', async () => {
    const user = userEvent.setup()
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    expect(box().value).toBe('')
    await user.type(box(), '5')
    await user.clear(box())
    expect(box().value).toBe('')
    expect(spy).toHaveBeenLastCalledWith('')
  })

  it('muestra un monto preexistente tal cual y permite editarlo', async () => {
    const user = userEvent.setup()
    render(<Harness initial="55.000" />)
    expect(box().value).toBe('55.000')
    box().focus()
    box().setSelectionRange(6, 6)
    await user.keyboard('0')
    expect(box().value).toBe('550.000')
  })

  it('es un input accesible con teclado normal (type text, inputMode decimal)', () => {
    render(<Harness />)
    expect(box().type).toBe('text')
    expect(box().inputMode).toBe('decimal')
    fireEvent.focus(box())
  })
})
