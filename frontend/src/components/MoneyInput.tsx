import { useLayoutEffect, useRef, type ClipboardEvent, type ChangeEvent, type InputHTMLAttributes } from 'react'
import { applyCopEdit, pasteIntoCop } from '../lib/format/cop'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> & {
  /** Texto visible ("1.200.000,50"). El valor para el backend se obtiene con `toWireMoney`. */
  value: string
  onChange: (display: string) => void
}

/**
 * Campo de monto en pesos: puntos de miles automáticos, decimales opcionales con coma.
 * Es un <input> normal, así que hereda los estilos de `.field input` sin cambios.
 */
export function MoneyInput({ value, onChange, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  const pendingCaret = useRef<number | null>(null)

  // Reubica el cursor después de que React escribe el valor formateado.
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  }, [value])

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const el = e.target
    const inputType = (e.nativeEvent as InputEvent).inputType
    const { value: next, caret } = applyCopEdit(value, el.value, el.selectionStart ?? el.value.length, inputType)
    pendingCaret.current = caret
    if (next === value) {
      // Nada cambió visualmente (p. ej. se tecleó una letra): restaura el texto y el cursor.
      el.value = next
      el.setSelectionRange(caret, caret)
      pendingCaret.current = null
      return
    }
    onChange(next)
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const el = e.currentTarget
    const text = e.clipboardData.getData('text')
    e.preventDefault()
    const { value: next, caret } = pasteIntoCop(value, el.selectionStart ?? 0, el.selectionEnd ?? 0, text)
    pendingCaret.current = caret
    if (next === value) {
      el.setSelectionRange(caret, caret)
      pendingCaret.current = null
      return
    }
    onChange(next)
  }

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={handleChange}
      onPaste={handlePaste}
    />
  )
}
