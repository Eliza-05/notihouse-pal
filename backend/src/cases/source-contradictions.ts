import { isJsonObject } from '../common/validators.js';

/**
 * E12 (PDD A5): dos fuentes (voz, Gmail, carga manual) describen la misma
 * obligación con datos incompatibles. Hasta que la persona resuelva cuál es la
 * correcta, ninguna se aplica. Funciones puras: la consulta vive en el
 * servicio de aplicación.
 */
export interface ProposalFacts {
  obligationId: string | null;
  providerName: string | null;
  amount: string | null;
  dueDate: string | null;
  periodStart: string | null;
}

const str = (v: unknown) =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** Extrae los datos comparables de una propuesta aplicable o de revisión manual. */
export function factsOf(proposedData: unknown): ProposalFacts | null {
  if (!isJsonObject(proposedData)) return null;
  const data = proposedData.data;
  if (isJsonObject(data)) {
    const occurrence = isJsonObject(data.occurrence) ? data.occurrence : data;
    const obligation = isJsonObject(data.obligation) ? data.obligation : {};
    return {
      obligationId: str(data.obligationId),
      providerName: str(obligation.providerName),
      amount: str(occurrence.amount),
      dueDate: str(occurrence.dueDate),
      periodStart: str(occurrence.periodStart),
    };
  }
  const x = proposedData.interpretacion;
  if (isJsonObject(x)) {
    return {
      obligationId: null,
      providerName: str(x.providerName),
      amount: str(x.amount),
      dueDate: str(x.dueDate),
      periodStart: str(x.periodStart),
    };
  }
  return null;
}

const SOCIETARY = /\b(s\s?a\s?s|s\s?a|e\s?s\s?p|ltda|sas|esp)\b/g;
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(SOCIETARY, ' ')
    .replace(/[^a-z0-9]+/g, '');

/** ¿Mismo proveedor? Tolera siglas societarias, tildes y nombres abreviados. */
export function sameProvider(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = normalize(a);
  const y = normalize(b);
  if (x.length < 4 || y.length < 4) return x === y;
  return x.includes(y) || y.includes(x);
}

const sameAmount = (a: string, b: string) =>
  Math.abs(Number(a) - Number(b)) < 0.005;

/**
 * ¿`other` contradice a `target` sobre la misma obligación y período?
 * Solo cuentan los datos conocidos que difieren: una fuente incompleta pero
 * coherente no es una contradicción, y dos fuentes idénticas son un posible
 * duplicado (E3), que el backend ya impide al aplicar.
 */
export function contradicts(
  target: ProposalFacts,
  targetProvider: string | null,
  other: ProposalFacts,
): boolean {
  const sameSubject =
    (target.obligationId !== null &&
      other.obligationId === target.obligationId) ||
    sameProvider(other.providerName, targetProvider);
  if (!sameSubject) return false;
  const samePeriod =
    !other.dueDate ||
    !target.dueDate ||
    other.dueDate.slice(0, 7) === target.dueDate.slice(0, 7) ||
    (other.periodStart !== null && other.periodStart === target.periodStart);
  if (!samePeriod) return false;
  const amountDiffers =
    other.amount !== null &&
    target.amount !== null &&
    !sameAmount(other.amount, target.amount);
  const dateDiffers =
    other.dueDate !== null &&
    target.dueDate !== null &&
    other.dueDate !== target.dueDate;
  return amountDiffers || dateDiffers;
}
