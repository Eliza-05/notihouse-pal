import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import landingBackground from '../../assets/backgrounds/LandingBackground.png'
import { Spinner } from '../../components/Feedback'
import { friendlyError } from '../../lib/api/messages'
import { clearSessionNotice, getSessionNotice, safeReturnPath } from '../../lib/auth/session'
import { useAuth } from '../../lib/auth/useAuth'
import { transitionClassName } from '../landing/transitionClassName'
// Reutiliza los tokens de color/tipografía (.landing-page) y la imagen de
// fondo de la Landing a propósito: Login es el mismo lienzo visual, solo con
// la cámara acercada (ver "Transición cinematográfica" en landing.css y
// login.css). Nada de esto duplica estilos; login.css solo añade lo propio
// de esta pantalla (el formulario y el tratamiento del fondo).
import '../landing/landing.css'
import './login.css'

/**
 * Login real (no una maqueta): mismo mecanismo de auth que ya existía antes
 * de esta pantalla (lib/auth, lib/api) — el backend solo soporta login con
 * las cuentas demo existentes, sin registro, sin recuperación de contraseña
 * ni proveedores externos (ver docs/architecture/authentication.md §1), así
 * que esta pantalla no incluye ni simula nada de eso.
 * - Validación igual a la que exige el backend: correo válido ≤254,
 *   contraseña no vacía ≤256, sin reglas de complejidad propias.
 * - Errores 400/401/429/red diferenciados.
 * - Aviso de arranque en frío de Render tras ~4s.
 */

const schema = z.object({
  email: z.string().min(1, 'Ingresa tu correo').max(254).email('Correo no válido'),
  password: z.string().min(1, 'Ingresa tu contraseña').max(256),
})

type FormValues = z.infer<typeof schema>

// Debe coincidir con el `transition` de salida más largo en login.css
// (.login-screen--leaving .login-screen__image).
const LEAVE_ANIMATION_MS = 820

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [serverError, setServerError] = useState<string | null>(null)
  const [wakingUp, setWakingUp] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // Controla la entrada del formulario por transición de React (no por
  // @keyframes): una animación con `forwards` deja su valor final de
  // opacity "ganando" sobre cualquier transition posterior en la misma
  // propiedad, lo que rompía el fundido de salida de handleBack. Con
  // transition para ambos sentidos no hay ese conflicto.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  // Ruta de retorno completa (pathname + búsqueda + hash). Si se recargó el login, la recuerda el aviso de sesión.
  const [notice, setNotice] = useState(getSessionNotice)
  const fromState = (location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null)?.from
  const from =
    safeReturnPath(fromState?.pathname ? `${fromState.pathname}${fromState.search ?? ''}${fromState.hash ?? ''}` : null) ??
    notice?.returnTo ??
    '/'

  async function onSubmit(values: FormValues) {
    setServerError(null)
    const wakeTimer = setTimeout(() => setWakingUp(true), 4000)

    try {
      await login(values)
      navigate(from, { replace: true })
    } catch (err) {
      setServerError(friendlyError(err, 'login'))
    } finally {
      clearTimeout(wakeTimer)
      setWakingUp(false)
    }
  }

  function handleBack() {
    if (leaving) return

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion) {
      navigate('/')
      return
    }

    setLeaving(true)
    window.setTimeout(() => navigate('/'), LEAVE_ANIMATION_MS)
  }

  return (
    <div className={`landing-page ${transitionClassName('login-screen', { mounted, leaving })}`}>
      {/* Mismo recurso que la Landing, sin segunda imagen (§4 del prompt de
          diseño): el acercamiento se logra solo con transform+filter sobre
          este <img>, anclado al mismo transform-origin que el Hero. */}
      <img src={landingBackground} alt="" className="login-screen__image" aria-hidden="true" />
      <div className="login-screen__vignette" aria-hidden="true" />

      <header className={transitionClassName('landing-header', { mounted, leaving })}>
        <span className="landing-header__brand">NotiHouse Pal</span>
        <button type="button" className="landing-header__login" onClick={handleBack} disabled={leaving}>
          {/* Misma clase `landing-header__login-label` que usa el botón
              "Iniciar Sesión" de la Landing (landing.css): entra/sale con
              fundido en vez de cambiar de texto de golpe en el instante del
              cambio de ruta. */}
          <span className="landing-header__login-label">Volver</span>
        </button>
      </header>

      <main className="login-screen__main">
        <form className="login-screen__form" onSubmit={handleSubmit(onSubmit)} noValidate>
          <h1 className="login-screen__title">Iniciar Sesión</h1>
          <p className="login-screen__subtitle">Bienvenido de vuelta</p>

          <div className="login-screen__field">
            <label htmlFor="email" className="login-screen__label">
              Correo electrónico
            </label>
            <input
              id="email"
              type="email"
              placeholder="Ingresa tu correo electrónico"
              autoComplete="email"
              className="login-screen__input"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-error' : undefined}
              {...register('email')}
            />
            {errors.email && (
              <span id="email-error" role="alert" className="login-screen__error">
                {errors.email.message}
              </span>
            )}
          </div>

          <div className="login-screen__field">
            <label htmlFor="password" className="login-screen__label">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              placeholder="Ingresa tu contraseña"
              autoComplete="current-password"
              className="login-screen__input"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'password-error' : undefined}
              {...register('password')}
            />
            {errors.password && (
              <span id="password-error" role="alert" className="login-screen__error">
                {errors.password.message}
              </span>
            )}
          </div>

          {notice && (
            <p role="status" className="login-screen__session-notice">
              {notice.reason === 'expired'
                ? 'Tu sesión venció (dura 30 minutos). Inicia sesión de nuevo para continuar donde estabas.'
                : 'Tu sesión ya no es válida. Inicia sesión de nuevo para continuar.'}{' '}
              <button
                type="button"
                className="login-screen__session-notice-close"
                onClick={() => {
                  clearSessionNotice()
                  setNotice(null)
                }}
              >
                Entendido
              </button>
            </p>
          )}

          {serverError && (
            <p role="alert" className="login-screen__server-error">
              {serverError}
            </p>
          )}
          {wakingUp && (
            <p className="login-screen__status" role="status">
              Estamos despertando el servidor, puede tardar hasta un minuto. No cierres esta pantalla.
            </p>
          )}

          <button type="submit" className="login-screen__submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined}>
            {isSubmitting ? (
              <span className="login-screen__busy">
                <Spinner size={16} /> Verificando tus datos…
              </span>
            ) : (
              'Iniciar sesión'
            )}
          </button>
        </form>
      </main>
    </div>
  )
}
