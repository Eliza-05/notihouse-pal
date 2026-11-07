import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { ApiError, isNetworkError } from '../../lib/api/errors'
import { useAuth } from '../../lib/auth/useAuth'

/**
 * Placeholder FUNCIONAL, sin diseño todavía (eso se decide en el paso 3,
 * portando la identidad visual del mockup). Lo que ya es real aquí:
 * - POST /auth/login real contra la API (sin Google, sin registro: el
 *   backend solo tiene login con las cuentas demo existentes, ver §B del
 *   README y §7.1 de la guía — no hay más mecanismos de auth que crear).
 * - Validación igual a la que exige el backend (§8.1): correo válido ≤254,
 *   contraseña no vacía ≤256, sin reglas de complejidad propias.
 * - Errores 400/401/429/red diferenciados (§11.6).
 * - Aviso de arranque en frío de Render tras ~4s (§8.1, §11.8).
 */

const schema = z.object({
  email: z.string().min(1, 'Ingresa tu correo').max(254).email('Correo no válido'),
  password: z.string().min(1, 'Ingresa tu contraseña').max(256),
})

type FormValues = z.infer<typeof schema>

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [serverError, setServerError] = useState<string | null>(null)
  const [wakingUp, setWakingUp] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'

  async function onSubmit(values: FormValues) {
    setServerError(null)
    const wakeTimer = setTimeout(() => setWakingUp(true), 4000)

    try {
      await login(values)
      navigate(from, { replace: true })
    } catch (err) {
      if (isNetworkError(err)) {
        setServerError('No pudimos conectar con el servidor. Verifica tu conexión e intenta de nuevo.')
      } else if (err instanceof ApiError) {
        if (err.status === 401) setServerError('Correo o contraseña incorrectos.')
        else if (err.status === 429) setServerError('Demasiados intentos. Espera un minuto e inténtalo de nuevo.')
        else setServerError(err.messages.join(' '))
      } else {
        setServerError('Ocurrió un error inesperado.')
      }
    } finally {
      clearTimeout(wakeTimer)
      setWakingUp(false)
    }
  }

  return (
    <main className="app-shell">
      <form onSubmit={handleSubmit(onSubmit)} noValidate style={{ display: 'grid', gap: '0.75rem', width: 'min(320px, 100%)' }}>
        <h1>NotiHouse-Pal — Iniciar sesión</h1>

        <label htmlFor="email">Correo</label>
        <input id="email" type="email" autoComplete="email" {...register('email')} aria-invalid={!!errors.email} />
        {errors.email && <span role="alert">{errors.email.message}</span>}

        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
          aria-invalid={!!errors.password}
        />
        {errors.password && <span role="alert">{errors.password.message}</span>}

        {serverError && <p role="alert">{serverError}</p>}
        {wakingUp && <p className="app-shell__status">Despertando el servidor, puede tardar hasta un minuto…</p>}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  )
}
