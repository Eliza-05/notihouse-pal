// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoadingButton, SkeletonRows, SkeletonTable, Spinner } from './Feedback'
import { ToastProvider, ToastViewport, useToast } from './Toasts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('LoadingButton', () => {
  it('mientras carga: spinner + texto de carga, aria-busy y no admite doble envío', () => {
    const onClick = vi.fn()
    function Harness() {
      const [loading, setLoading] = useState(false)
      return (
        <LoadingButton
          loading={loading}
          loadingText="Guardando…"
          onClick={() => {
            onClick()
            setLoading(true)
          }}
        >
          Guardar
        </LoadingButton>
      )
    }
    render(<Harness />)
    const btn = screen.getByRole('button', { name: 'Guardar' })
    expect(btn.getAttribute('aria-busy')).toBeNull()
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
    const busy = screen.getByRole('button', { name: 'Guardando…' })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    expect(busy.querySelector('.nh-spin')).not.toBeNull()
  })

  it('al terminar (también tras un error) vuelve a su estado normal', () => {
    const { rerender } = render(<LoadingButton loading loadingText="Guardando…">Guardar</LoadingButton>)
    expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true')
    rerender(<LoadingButton loading={false} loadingText="Guardando…">Guardar</LoadingButton>)
    const btn = screen.getByRole('button', { name: 'Guardar' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-busy')).toBeNull()
    expect(btn.querySelector('.nh-spin')).toBeNull()
  })

  it('un botón deshabilitado por otra razón sigue deshabilitado', () => {
    render(<LoadingButton disabled>Enviar</LoadingButton>)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('esqueletos accesibles', () => {
  it('anuncian «Cargando…» una sola vez y marcan la región como ocupada', () => {
    render(<SkeletonRows rows={3} label="Cargando bandeja…" />)
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-busy')).toBe('true')
    expect(screen.getAllByText('Cargando bandeja…')).toHaveLength(1)
    expect(region.querySelectorAll('.nh-skeleton').length).toBeGreaterThan(3)
  })

  it('la tabla conserva la forma (filas y columnas) para evitar saltos', () => {
    const { container } = render(<SkeletonTable rows={3} cols={4} />)
    expect(container.querySelectorAll('.nh-skel-tr')).toHaveLength(4) // encabezado + 3 filas
  })

  it('el spinner es decorativo para lectores de pantalla', () => {
    const { container } = render(<Spinner />)
    expect(container.querySelector('.nh-spin')!.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('toasts (feedback de acción y avisos)', () => {
  let api: ReturnType<typeof useToast>
  function Probe() {
    api = useToast()
    return null
  }
  function mount() {
    return render(
      <MemoryRouter>
        <ToastProvider>
          <Probe />
          <ToastViewport />
        </ToastProvider>
      </MemoryRouter>,
    )
  }
  beforeEach(() => vi.useFakeTimers())

  it('un éxito se muestra, se anuncia con cortesía y se cierra solo', () => {
    mount()
    act(() => api.success('Cambios guardados.'))
    expect(screen.getByText('Cambios guardados.')).toBeTruthy()
    expect(screen.getByText('Cambios guardados.').closest('[aria-live="polite"]')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(4_500) })
    expect(screen.queryByText('Cambios guardados.')).toBeNull()
  })

  it('los éxitos repetidos no se acumulan', () => {
    mount()
    act(() => { api.success('Cambios guardados.'); api.success('Cambios guardados.'); api.success('Cambios guardados.') })
    expect(screen.getAllByText('Cambios guardados.')).toHaveLength(1)
  })

  it('los errores se anuncian como alerta y permanecen más tiempo', () => {
    mount()
    act(() => api.error('No pudimos conectarnos en este momento.'))
    expect(screen.getByText('No pudimos conectarnos en este momento.').closest('[aria-live="assertive"]')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.getByText('No pudimos conectarnos en este momento.')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.queryByText('No pudimos conectarnos en este momento.')).toBeNull()
  })

  it('máximo 3 visibles: el más antiguo cede el lugar', () => {
    mount()
    act(() => { for (const m of ['uno', 'dos', 'tres', 'cuatro']) api.info(m) })
    expect(screen.queryByText('uno')).toBeNull()
    expect(screen.getByText('cuatro')).toBeTruthy()
  })

  it('un aviso con id estable se actualiza en lugar de duplicarse y enlaza a su pantalla', () => {
    mount()
    act(() => api.notify({ id: 'k1', title: 'Tienes una factura por revisar', message: 'Aseo Verde por $87.400', to: '/revisiones/h1', actionLabel: 'Revisar factura' }))
    act(() => api.notify({ id: 'k1', title: 'Tienes una factura por revisar', message: 'Aseo Verde por $87.400', to: '/revisiones/h1', actionLabel: 'Revisar factura' }))
    expect(screen.getAllByText('Tienes una factura por revisar')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Revisar factura' }).getAttribute('href')).toBe('/revisiones/h1')
  })

  it('se puede cerrar a mano y clear() vacía todo (cambio de usuario)', () => {
    mount()
    act(() => { api.success('A'); api.info('B') })
    fireEvent.click(screen.getAllByRole('button', { name: 'Cerrar aviso' })[0]!)
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByText('A')).toBeNull()
    act(() => api.clear())
    expect(screen.queryByText('B')).toBeNull()
  })

  it('pausa el cierre automático mientras el cursor está encima', () => {
    mount()
    act(() => api.success('Pausa'))
    const toast = screen.getByText('Pausa').closest('.toast')!
    fireEvent.mouseEnter(toast)
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(screen.getByText('Pausa')).toBeTruthy()
    fireEvent.mouseLeave(toast)
    act(() => { vi.advanceTimersByTime(4_500) })
    expect(screen.queryByText('Pausa')).toBeNull()
  })
})
