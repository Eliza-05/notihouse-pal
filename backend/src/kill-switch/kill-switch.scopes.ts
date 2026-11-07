import { PROPOSAL_ACTIONS } from '../cases/proposal-actions.js';
import { isJsonObject } from '../common/validators.js';

/**
 * Alcances del kill switch (SDD B3 y §6 "Contención"). Cada uno corresponde a
 * un componente que escribe de forma automática o que lleva datos
 * interpretados por IA a la fuente de verdad. `global` los incluye todos.
 * Ninguno bloquea lecturas ni las acciones manuales del usuario (registrar,
 * confirmar pagos, decidir revisiones): el kill switch detiene a la
 * automatización, no a la persona.
 */
export const KILL_SWITCH_SCOPES = [
  'global',
  'gmail_ingestion',
  'document_processing',
  'voice_processing',
  'case_processing',
  'hitl_closure',
  'hitl_expiry',
  'alert_evaluation',
  'proposal_application',
] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

/** Texto visible para el usuario cuando una función queda limitada. */
export const SCOPE_LABELS: Record<KillSwitchScope, string> = {
  global: 'Todas las automatizaciones',
  gmail_ingestion: 'Recepción de facturas desde Gmail',
  document_processing: 'Interpretación automática de documentos PDF',
  voice_processing: 'Interpretación automática de notas de voz',
  case_processing: 'Procesamiento automático de casos',
  hitl_closure: 'Cierre automático de casos revisados',
  hitl_expiry: 'Vencimiento automático de revisiones humanas',
  alert_evaluation: 'Generación automática de alertas',
  proposal_application: 'Aplicación de propuestas aprobadas',
};

/** Tipo de trabajo de la cola → componente que lo procesa. */
const JOB_TYPE_SCOPES: Record<string, KillSwitchScope> = {
  'document.process': 'document_processing',
  'voice.transcribe': 'voice_processing',
  'hitl.decision': 'hitl_closure',
};

export function scopeOfJobType(jobType: string): KillSwitchScope {
  if (JOB_TYPE_SCOPES[jobType]) return JOB_TYPE_SCOPES[jobType];
  if (jobType.startsWith('case.')) return 'case_processing';
  // Un tipo desconocido solo se detiene con el kill switch global.
  return 'global';
}

/** Tipos de trabajo conocidos de un alcance (para excluirlos al reclamar). */
export function jobTypesOfScope(scope: KillSwitchScope): string[] {
  return Object.entries(JOB_TYPE_SCOPES)
    .filter(([, s]) => s === scope)
    .map(([type]) => type);
}

/**
 * Operaciones expresamente prohibidas al agente (PDD B1 "Decisiones
 * prohibidas", R5, R6, R8, R9, R11, R12, R14). Si una propuesta del servicio
 * de automatización las pide, no es un error de interpretación: es una señal
 * de que el flujo fue manipulado (por ejemplo, por una inyección en el
 * documento). El SDD exige activar el kill switch de inmediato.
 */
const PROHIBITED_DATA_KEYS = new Set([
  'status',
  'paid',
  'paidat',
  'paymentconfirmed',
  'confirmedat',
  'confirmedby',
  'received',
  'receivedat',
  'receivedby',
  'ownerid',
  'assignedto',
  'transfer',
  'payment',
  'bankaccount',
  'password',
]);

function findProhibitedKey(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProhibitedKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isJsonObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_DATA_KEYS.has(key.toLowerCase())) return key;
    const found = findProhibitedKey(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Devuelve el motivo si `proposedData` pide una operación prohibida, o `null`.
 * Solo se examinan propuestas con forma de acción (`{ action, ... }`): las
 * propuestas no aplicables (`interpretacion`, `camposProblematicos`) llevan
 * el texto interpretado tal cual y pueden mencionar, por ejemplo, un
 * `paymentStatus` leído del documento sin pedir ninguna operación.
 */
export function detectProhibitedOperation(
  proposedData: unknown,
): string | null {
  if (!isJsonObject(proposedData) || !('action' in proposedData)) return null;
  const { action, data } = proposedData;
  if (
    typeof action !== 'string' ||
    !(PROPOSAL_ACTIONS as readonly string[]).includes(action)
  ) {
    return `acción no permitida: ${String(action).slice(0, 60)}`;
  }
  const key = findProhibitedKey(data);
  return key ? `campo prohibido en los datos: ${key.slice(0, 40)}` : null;
}
