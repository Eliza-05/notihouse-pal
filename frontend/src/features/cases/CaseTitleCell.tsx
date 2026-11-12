import { useProposals } from './hooks'
import { caseTitle, isAssistantRequest, proposalAction } from './caseTitle'
import type { Case } from '../../lib/api/types'

/**
 * Celda «Tipo» de Mis solicitudes. Solo las solicitudes al asistente (texto/voz) con propuesta pueden estar
 * mal rotuladas por su tipo almacenado; las demás no consultan nada.
 */
export function CaseTitleCell({ item }: { item: Pick<Case, 'id' | 'type' | 'source' | 'status'> }) {
  const needsProposal = isAssistantRequest(item) && (item.status === 'awaiting_human' || item.status === 'completed')
  const { data } = useProposals(needsProposal ? item.id : undefined)
  return <>{caseTitle(item, proposalAction(data?.items))}</>
}
