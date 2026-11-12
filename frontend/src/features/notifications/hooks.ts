import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { queryKey } from '../../lib/api/queryKey'
import { useAuth } from '../../lib/auth/useAuth'
import * as attentionApi from '../attention/api'
import * as casesApi from '../cases/api'
import { parseProposal } from '../cases/proposalSchema'
import { reviewHeading, type ReviewHeading } from '../cases/reviewSummary'
import { badgeCount, deriveNotifications, type AppNotification } from './derive'

/** Intervalos deliberadamente lentos: es un aviso en segundo plano, no una pantalla en vivo. */
const POLL_PENDING_MS = 30_000
const POLL_APPROVED_MS = 60_000
const POLL_ATTENTION_MS = 30_000
/** Cuántas revisiones se enriquecen con su propuesta (detalle): acota las consultas. */
const MAX_DETAILS = 6
/** Solo interesa «aprobada y sin aplicar» de los últimos días. */
const APPROVED_WINDOW_MS = 14 * 24 * 3600 * 1000

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible')
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  return visible
}

export interface NotificationsState {
  notifications: AppNotification[]
  /** Título y descripción distinguibles por id de revisión (pendientes y aprobadas recientes). */
  reviewHeadings: ReadonlyMap<string, ReviewHeading>
  badge: number
  /** Aún no hay ningún dato (primera carga). */
  isLoading: boolean
  /** Fallaron las fuentes principales y no hay datos previos que mostrar. */
  isError: boolean
  /** Las fuentes principales y los detalles ya respondieron (o fallaron): se puede decidir qué anunciar. */
  ready: boolean
  refetch: () => void
}

/**
 * Reutiliza los endpoints y las claves de caché existentes (hitl, hitl-detail, attention), así
 * que decidir/aplicar una revisión (`invalidateAfterDecision`) refresca la campana al instante
 * y al cambiar de usuario `AuthCacheSync` vacía todo. Las consultas se pausan con la pestaña
 * oculta (refetchIntervalInBackground: false) y se revalidan al volver (refetchOnWindowFocus).
 */
export function useNotifications(): NotificationsState {
  const { user, isAuthenticated } = useAuth()
  const uid = user?.id ?? ''
  const enabled = isAuthenticated && !!user
  const visible = useDocumentVisible()

  const pendingQ = useQuery({
    queryKey: queryKey(uid, 'hitl', { status: 'pending', pageSize: 10 }),
    queryFn: ({ signal }) => casesApi.listHitlRequests({ status: 'pending', pageSize: 10 }, signal),
    enabled,
    staleTime: 15_000,
    refetchInterval: visible ? POLL_PENDING_MS : false,
    refetchIntervalInBackground: false,
  })

  const approvedQ = useQuery({
    queryKey: queryKey(uid, 'hitl', { status: 'approved', pageSize: 5 }),
    queryFn: ({ signal }) => casesApi.listHitlRequests({ status: 'approved', pageSize: 5 }, signal),
    enabled,
    staleTime: 30_000,
    refetchInterval: visible ? POLL_APPROVED_MS : false,
    refetchIntervalInBackground: false,
  })

  const attentionQ = useQuery({
    queryKey: queryKey(uid, 'attention', { page: 1, pageSize: 20 }),
    queryFn: ({ signal }) => attentionApi.listAttention({ page: 1, pageSize: 20 }, signal),
    enabled,
    staleTime: 15_000,
    refetchInterval: visible ? POLL_ATTENTION_MS : false,
    refetchIntervalInBackground: false,
  })

  const pendingItems = useMemo(() => (pendingQ.data?.items ?? []).filter((h) => h.status === 'pending').slice(0, MAX_DETAILS), [pendingQ.data])
  const approvedItems = useMemo(() => {
    const since = Date.now() - APPROVED_WINDOW_MS
    return (approvedQ.data?.items ?? [])
      .filter((h) => h.status === 'approved' && h.decisionType === 'data_confirmation' && h.proposalId && (!h.respondedAt || new Date(h.respondedAt).getTime() >= since))
      .slice(0, MAX_DETAILS)
  }, [approvedQ.data])

  const detailIds = useMemo(() => [...new Set([...pendingItems, ...approvedItems].map((h) => h.id))], [pendingItems, approvedItems])
  const detailQs = useQueries({
    queries: detailIds.map((id) => ({
      queryKey: queryKey(uid, 'hitl-detail', id),
      queryFn: ({ signal }: { signal: AbortSignal }) => casesApi.getHitlRequest(id, signal),
      enabled,
      staleTime: 30_000,
    })),
  })
  const detailsById = new Map(detailIds.map((id, i) => [id, detailQs[i]?.data] as const))
  const detailsSettled = detailQs.every((q) => !q.isPending)

  const notifications = useMemo(
    () =>
      deriveNotifications({
        userId: uid,
        pending: pendingItems.map((request) => ({ request, detail: detailsById.get(request.id) })),
        approved: approvedItems.map((h) => detailsById.get(h.id)).filter((d): d is NonNullable<typeof d> => !!d),
        attention: attentionQ.data?.items ?? [],
      }),
    // detailsById se reconstruye en cada render; su contenido cambia solo cuando cambian estos datos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uid, pendingItems, approvedItems, attentionQ.data, detailQs.map((q) => q.dataUpdatedAt).join(',')],
  )

  const reviewHeadings = useMemo(() => {
    const map = new Map<string, ReviewHeading>()
    for (const q of detailQs) {
      const d = q.data
      if (d) map.set(d.id, reviewHeading(d, d.proposal ? parseProposal(d.proposal.proposedData) : null))
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailQs.map((q) => q.dataUpdatedAt).join(',')])

  const hasAnyData = !!pendingQ.data || !!attentionQ.data
  const ready = enabled && !pendingQ.isPending && !attentionQ.isPending && !approvedQ.isPending && detailsSettled

  return {
    notifications,
    reviewHeadings,
    badge: badgeCount(notifications),
    isLoading: enabled && !hasAnyData && (pendingQ.isPending || attentionQ.isPending),
    isError: !hasAnyData && (pendingQ.isError || attentionQ.isError),
    ready,
    refetch: () => {
      void pendingQ.refetch()
      void attentionQ.refetch()
      void approvedQ.refetch()
    },
  }
}
