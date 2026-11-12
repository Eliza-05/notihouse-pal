/**
 * Resolución ESTRICTA de la dirección de entrega (plus addressing) de un mensaje de Gmail.
 *
 * Esta función es el único lugar donde se decide si un mensaje pertenece al alias esperado. El generador
 * del workflow 05b (build-workflow-05b.mjs) la incrusta tal cual (Function.prototype.toString) en el nodo
 * «Extraer adjuntos», de modo que lo que se prueba aquí es exactamente lo que corre en n8n. Por eso debe
 * ser AUTOCONTENIDA: sin importaciones ni referencias a variables externas.
 *
 * Principios:
 *  - Nunca se asigna por defecto: ante cualquier duda se RECHAZA, sin efectos (ni caso, ni documento, ni trabajo).
 *  - Dos señales independientes y coherentes: (1) la etiqueta que Gmail aplica por su propio filtro y (2) el
 *    PRIMER `Delivered-To` (lo antepone el servidor receptor; los que trae el remitente quedan por debajo).
 *    `To`/`Cc` solo sirven para DETECTAR contradicciones: los controla el remitente y nunca autorizan nada.
 *  - La identidad OAuth del buzón (users.getProfile) es otra cosa y se verifica aparte, en el workflow.
 *  - El resultado `mailbox` es siempre la dirección ESPERADA de la configuración, nunca texto del mensaje.
 *
 * @param {{headers: {name: string, value: string}[], labelIds: string[], labelNames: Record<string,string>,
 *          expectedAlias: string, expectedLabel: string, labelPrefix: string}} input
 * @returns {{ok: true, mailbox: string, evidencia: object} | {ok: false, reason: string}}
 */
export function resolveDelivery(input) {
  const reject = (reason) => ({ ok: false, reason });
  const headers = Array.isArray(input?.headers) ? input.headers : [];
  const labelIds = Array.isArray(input?.labelIds) ? input.labelIds : [];
  const labelNames = input?.labelNames && typeof input.labelNames === 'object' ? input.labelNames : {};

  // Dirección → { base, tag, domain, full }. Gmail ignora los puntos y las mayúsculas de la parte local y
  // trata googlemail.com como gmail.com; `tag` es null sin «+», '' con «+» vacío (malformado).
  const canon = (raw) => {
    const m = /^([a-z0-9._%+-]+)@([a-z0-9.-]+)$/.exec(String(raw ?? '').trim().toLowerCase());
    if (!m) return null;
    const domain = m[2] === 'googlemail.com' ? 'gmail.com' : m[2];
    const plus = m[1].indexOf('+');
    const local = plus === -1 ? m[1] : m[1].slice(0, plus);
    const base = domain === 'gmail.com' ? local.replace(/\./g, '') : local;
    const tag = plus === -1 ? null : m[1].slice(plus + 1);
    return { base, tag, domain, full: `${base}${tag === null ? '' : `+${tag}`}@${domain}` };
  };
  const addressesIn = (value) => (String(value ?? '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []).map(canon).filter(Boolean);

  const expected = canon(input?.expectedAlias);
  if (!expected || !expected.tag) return reject('configuracion_invalida');
  const expectedLabel = String(input?.expectedLabel ?? '');
  const labelPrefix = String(input?.labelPrefix ?? '');
  if (!expectedLabel) return reject('configuracion_invalida');
  const isOurs = (a) => a.base === expected.base && a.domain === expected.domain;
  const named = (name) => headers.filter((h) => String(h?.name ?? '').toLowerCase() === name);

  // 1) Cabeceras que no pueden repetirse (RFC 5322): una repetición es una señal de manipulación.
  if (named('to').length > 1 || named('cc').length > 1) return reject('encabezados_duplicados');

  // 2) Primer Delivered-To: lo pone Gmail; debe existir y ser una única dirección de ESTA cuenta, con alias.
  const delivered = named('delivered-to');
  if (delivered.length === 0) return reject('sin_delivered_to');
  const first = addressesIn(delivered[0].value);
  if (first.length !== 1 || !isOurs(first[0])) return reject('delivered_to_no_propio');
  if (first[0].tag === null) return reject('direccion_general');
  if (first[0].tag === '') return reject('alias_malformado');
  if (first[0].full !== expected.full) return reject('alias_distinto');
  // Otros Delivered-To de nuestra cuenta con otra dirección: contradictorio. Los ajenos (reenvíos) se ignoran.
  for (const h of delivered.slice(1)) {
    for (const a of addressesIn(h.value)) if (isOurs(a) && a.full !== expected.full) return reject('delivered_to_contradictorio');
  }

  // 3) To/Cc: ninguna otra dirección de la cuenta (ni la general ni otro alias). Si el alias esperado no
  //    aparece (Bcc), basta con las dos señales independientes de arriba y de la etiqueta.
  let inRecipients = false;
  for (const h of [...named('to'), ...named('cc')]) {
    for (const a of addressesIn(h.value)) {
      if (!isOurs(a)) continue;
      if (a.full !== expected.full) return reject('destinatarios_contradictorios');
      inRecipients = true;
    }
  }

  // 4) Etiquetas: debe estar la esperada y NINGUNA otra del mismo prefijo (nh-*).
  const names = labelIds.map((id) => labelNames[id]).filter((n) => typeof n === 'string');
  if (!names.includes(expectedLabel)) return reject('etiqueta_ausente');
  if (labelPrefix && names.filter((n) => n.startsWith(labelPrefix)).length !== 1) return reject('etiqueta_incoherente');

  return { ok: true, mailbox: expected.full, evidencia: { deliveredTo: true, etiqueta: expectedLabel, enDestinatarios: inRecipients } };
}
