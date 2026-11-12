import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useToast } from '../../components/Toasts'
import { useAuth } from '../../lib/auth/useAuth'
import { newToastCandidates } from './derive'
import { useNotificationsState } from './NotificationsProvider'

function readSet(key: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(key)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeSet(key: string, set: Set<string>) {
  try {
    sessionStorage.setItem(key, JSON.stringify([...set].slice(-200)))
  } catch {
    /* sin almacenamiento: solo se pierde la memoria entre recargas de la pestaña */
  }
}

/**
 * Convierte avisos NUEVOS de prioridad alta en toasts. No dibuja nada.
 *
 *  - La primera carga de cada sesión fija la línea base: lo que ya estaba pendiente no se anuncia
 *    como si acabara de llegar; solo se muestra UN resumen discreto por sesión.
 *  - Después, cada clave (usuario + recurso + evento) se anuncia una sola vez, aunque el polling
 *    la vea repetidamente. La memoria de «ya anunciado» vive en sessionStorage por usuario.
 *  - Si la persona ya está en la pantalla del aviso, no se le avisa de algo que está mirando.
 */
export function NotificationToaster() {
  const { user } = useAuth()
  const uid = user?.id ?? ''
  const { notifications, ready } = useNotificationsState()
  const toast = useToast()
  const { pathname } = useLocation()
  const baselineDone = useRef(false)
  const announced = useRef<Set<string> | null>(null)
  const pathRef = useRef(pathname)
  pathRef.current = pathname
  const pending = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    const timers = pending.current
    return () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const signature = notifications.map((n) => n.key).join('|')

  useEffect(() => {
    if (!uid || !ready) return
    const announcedKey = `nh-notif-announced:${uid}`
    const summaryKey = `nh-notif-summary:${uid}`
    if (!announced.current) announced.current = readSet(announcedKey)
    const known = announced.current

    if (!baselineDone.current) {
      baselineDone.current = true
      const high = notifications.filter((n) => n.priority === 'high')
      const alreadyKnown = high.length > 0 && high.every((n) => known.has(n.key))
      for (const n of notifications) known.add(n.key)
      writeSet(announcedKey, known)
      let summarized = false
      try {
        summarized = sessionStorage.getItem(summaryKey) === '1'
      } catch {
        /* ignorar */
      }
      if (high.length > 0 && !summarized && !alreadyKnown) {
        toast.notify({
          id: `summary:${uid}`,
          title: high.length === 1 ? 'Tienes 1 asunto por atender' : `Tienes ${high.length} asuntos por atender`,
          message: 'Abre la campana o la Bandeja para continuar.',
          to: '/atencion',
          actionLabel: 'Abrir Bandeja',
        })
        try {
          sessionStorage.setItem(summaryKey, '1')
        } catch {
          /* ignorar */
        }
      }
      return
    }

    for (const n of newToastCandidates(notifications, known, true)) {
      known.add(n.key)
      if (pathRef.current === n.to) continue // ya la está viendo
      // Breve espera y se vuelve a comprobar: si la persona está siendo llevada a esa pantalla
      // (p. ej. al elegir una alternativa que abre la nueva revisión), el aviso sería redundante.
      const timer = setTimeout(() => {
        pending.current.delete(timer)
        if (pathRef.current === n.to) return
        toast.notify({ id: n.key, title: n.title, message: n.body, to: n.to, actionLabel: n.actionLabel })
      }, 700)
      pending.current.add(timer)
    }
    writeSet(announcedKey, known)
    // `signature` resume el contenido de la lista: no se vuelve a evaluar por cambios de identidad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, ready, signature])

  return null
}
