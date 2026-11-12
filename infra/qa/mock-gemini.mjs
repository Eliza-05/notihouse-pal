/**
 * Gemini SIMULADO para QA local. NO es el modelo real: ninguna prueba que lo use
 * puede declararse «interpretación real con Gemini». Marca modelVersion = "SIMULADO-qa".
 *
 *   node infra/qa/mock-gemini.mjs            (puerto 3200, solo 127.0.0.1... y accesible
 *                                              desde Docker como host.docker.internal)
 *
 * - Interpretación: extractor por reglas sobre el texto entre <mensaje>…</mensaje>.
 * - Transcripción: devuelve la transcripción fijada con POST /__control {"transcript":"…"}
 *   (el audio de prueba es ficticio). Un tono corto (preflight) → sin voz.
 * - POST /__control {"nextInterpretation": {...}, "nextSkip": 1} fuerza la interpretación posterior a `nextSkip` llamadas (el sondeo previo de una ejecución manual cuenta como una)
 * - POST /__control {"nextInterpretation": {...}} fuerza la PRÓXIMA interpretación
 *   (p. ej. un modelo que inventa un proveedor) para probar los controles deterministas.
 * - failNext también admite 'invalid_json' (200 con texto no JSON), 'empty' (sin candidatos) y 'hang' (no responde).
 * - POST /__control {"failNext": 429, "failSkip": 1} hace que la próxima llamada (tras saltar failSkip) falle con ese estado.
 * - GET /__stats: número de llamadas (para comprobar que no hay llamadas de más).
 */
import http from 'node:http';

const state = { transcript: 'Registra la factura de agua de Acueducto por 98.500 pesos', nextInterpretation: null, nextSkip: 0, failNext: null, failSkip: 0, calls: { transcribe: 0, interpret: 0, preflight: 0 } };

const PROVIDERS = [
  ['Claro', 'mobile', 'Servicio móvil'], ['Movistar', 'mobile', 'Servicio móvil'], ['Tigo', 'internet', 'Internet'], ['ETB', 'internet', 'Internet'],
  ['Vanti', 'gas', 'Gas natural'], ['EPM', 'electricity', 'Energía eléctrica'], ['Enel', 'electricity', 'Energía eléctrica'], ['Acueducto', 'water', 'Acueducto y alcantarillado'],
];
const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

function interpret(text) {
  const t = text.toLowerCase();
  const x = { intent: 'unsupported', providerName: null, concept: null, category: null, propertyName: null, tenantAlias: null, amount: null, currency: null, dueDay: null, reminderDaysBefore: null, reminderDay: null, frequency: null, month: null, dueDate: null, startDate: null, missing: [], ambiguities: [], evidence: [], containsInstructions: false };
  const ev = (field, frag) => { const i = text.toLowerCase().indexOf(frag.toLowerCase()); if (i >= 0) x.evidence.push({ field, text: text.slice(i, i + frag.length) }); };
  if (/ignora (todas )?las instrucciones|ignore (all )?previous|system prompt|marca (esto )?como pagad/.test(t)) x.containsInstructions = true;
  const p = PROVIDERS.find(([n]) => new RegExp('\\b' + n + '\\b', 'i').test(text));
  if (p) { x.providerName = p[0]; x.category = p[1]; x.concept = p[2]; ev('providerName', p[0]); }
  if (!p && /internet/i.test(text)) { x.category = 'internet'; ev('category', 'internet'); }
  const am = /(?:por|valor(?: de)?|de|\$)\s*\$?\s*(\d{1,3}(?:[.,]\d{3})+|\d{4,})(?:\s*(pesos|cop))?/i.exec(text);
  if (am) { x.amount = Number(am[1].replace(/[.,]/g, '')).toFixed(2); ev('amount', am[1]); if (am[2] || /\$/.test(am[0])) x.currency = 'COP'; }
  const day = /(?:d[ií]a|el)\s+(\d{1,2})(?:\s+de cada mes)?/i.exec(text);
  if (day) { x.dueDay = Number(day[1]); ev('dueDay', day[0].trim()); }
  const rb = /(\d{1,2})\s+d[ií]as antes/i.exec(text);
  if (rb) { x.reminderDaysBefore = Number(rb[1]); ev('reminderDaysBefore', rb[0]); }
  if (/cada mes|mensual/i.test(text)) { x.frequency = 'monthly'; ev('frequency', /cada mes|mensual/i.exec(text)[0]); }
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const long = /(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de (\d{4})/i.exec(text);
  // «a partir del <fecha>» es la fecha de INICIO de un arriendo, no un vencimiento.
  const from = /a partir (?:del?|de la)\s+(\d{1,2} de [a-zá-ú]+ de \d{4}|\d{4}-\d{2}-\d{2})/i.exec(text);
  if (from) {
    const lm = /(\d{1,2}) de ([a-zá-ú]+) de (\d{4})/i.exec(from[1]);
    x.startDate = lm ? `${lm[3]}-${String(MONTHS[lm[2].toLowerCase()] ?? 0).padStart(2, '0')}-${lm[1].padStart(2, '0')}` : from[1];
    ev('startDate', from[1]);
  } else if (iso) { x.dueDate = iso[0]; ev('dueDate', iso[0]); } else if (long) { x.dueDate = `${long[3]}-${String(MONTHS[long[2].toLowerCase()]).padStart(2, '0')}-${long[1].padStart(2, '0')}`; ev('dueDate', long[0]); }
  const prop = /(Casa \d+|Apartamento \w+)/i.exec(text);
  if (prop) { x.propertyName = prop[1]; ev('propertyName', prop[1]); }
  const ten = /inquilin[oa]\s+([A-ZÁÉÍÓÚ][\wáéíóúñ]+)/.exec(text);
  if (ten) { x.tenantAlias = ten[1]; ev('tenantAlias', ten[1]); }
  // Intención
  if (/ya pagu|pagu[eé] |ya se pag[oó]|pagado/.test(t) && !/arriendo/.test(t)) x.intent = 'declare_payment';
  else if (/recib[ií].*arriendo|arriendo.*recib[ií]/.test(t)) x.intent = 'declare_rent_received';
  else if (/no (me )?pag[oó]|no ha pagado/.test(t) && /arriendo|inquilin/.test(t)) x.intent = 'report_rent_unpaid';
  else if (/arriendo|inquilin/.test(t)) x.intent = 'create_recurring_rental';
  else if (/ya no (pago|tengo|uso|quiero|necesito)|elimin|archiv|dar de baja|cancel[oó] (el|la|mi)/.test(t) && /obligaci|internet|servicio|plan|factura|agua|gas|energ/.test(t)) x.intent = 'archive_obligation';
  else if (/cambia|cambiar|modifica|mueve|mover|pasa el vencimiento/.test(t)) x.intent = 'update_obligation_schedule';
  else if (/factura|me lleg[oó]/.test(t) && x.amount) x.intent = 'register_invoice';
  else if (/registra|agrega|crea|nueva obligaci|cada mes|mensual/.test(t) && x.providerName) x.intent = 'create_recurring_obligation';
  if (x.intent === 'unsupported') x.missing = [];
  return x;
}

// Factura (workflow 02): extractor por reglas sobre el texto del PDF entre <documento>…</documento>.
function interpretInvoice(doc) {
  const g = (re) => re.exec(doc)?.[1]?.trim() ?? null;
  const ev = (field, frag) => (frag && doc.includes(frag) ? [{ field, text: frag }] : []);
  const provider = g(/Emisor:\s*([^\n]+)/);
  const concept = g(/Concepto:\s*([^\n]+)/);
  const ps = /del (\d{4}-\d{2}-\d{2}) al (\d{4}-\d{2}-\d{2})/.exec(doc);
  const due = g(/(?:Fecha limite de pago|Fecha de vencimiento|Vence)[: ]+(\d{4}-\d{2}-\d{2})/i);
  const total = g(/Total a pagar:\s*([\d.,]+)/i);
  const amount = total ? Number(total.replace(/\./g, '').replace(',', '.')).toFixed(2) : null;
  const inj = /ignora (todas )?las instrucciones|system prompt|marca (esta factura )?como pagad/i.test(doc);
  return {
    isInvoice: Boolean(provider && amount), providerName: provider, concept, category: /internet/i.test(concept ?? '') ? 'internet' : 'other',
    periodStart: ps?.[1] ?? null, periodEnd: ps?.[2] ?? null, dueDate: due, amount, currency: /COP/.test(doc) ? 'COP' : null,
    amountCandidates: amount ? [{ value: amount, label: 'Total a pagar' }] : [], containsInstructions: inj,
    evidence: [...ev('providerName', provider), ...ev('amount', total), ...ev('dueDate', due)],
  };
}

const wrap = (obj) => ({ modelVersion: 'SIMULADO-qa', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] });

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 30e6) req.destroy(); });
  req.on('end', () => {
    const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (req.url === '/__stats') return send(200, state.calls);
    if (req.url === '/__control' && req.method === 'POST') { Object.assign(state, JSON.parse(body || '{}')); return send(200, { ok: true }); }
    if (!/:generateContent$/.test(req.url.split('?')[0])) return send(404, { error: 'not found' });
    if (state.failNext && state.failSkip > 0) state.failSkip -= 1;
    else if (state.failNext === 'invalid_json') { state.failNext = null; return send(200, { modelVersion: 'SIMULADO-qa', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'no es json {intent:' }] } }] }); }
    else if (state.failNext === 'empty') { state.failNext = null; return send(200, { modelVersion: 'SIMULADO-qa', candidates: [] }); }
    else if (state.failNext === 'hang') { state.failNext = null; return; } // nunca responde: prueba el tiempo de espera de n8n
    else if (state.failNext) { const c = state.failNext; state.failNext = null; return send(c, { error: { code: c, message: c === 429 ? 'Quota exceeded: PerDay limit (simulado)' : 'simulado' } }); }
    const r = JSON.parse(body);
    const sys = r.systemInstruction?.parts?.[0]?.text ?? '';
    if (sys.startsWith('Transcribes')) {
      const data = r.contents?.[0]?.parts?.find((q) => q.inlineData)?.inlineData?.data ?? '';
      if (data.length < 20000) { state.calls.preflight += 1; return send(200, wrap({ hasSpeech: false, language: null, transcript: '', uncertainFragments: [] })); }
      state.calls.transcribe += 1;
      return send(200, wrap({ hasSpeech: true, language: 'es', transcript: state.transcript, uncertainFragments: [] }));
    }
    state.calls.interpret += 1;
    // `nextSkip`: interpretaciones que se responden con el extractor por defecto antes de aplicar `nextInterpretation` (p. ej. 1 = el sondeo previo de una ejecución manual).
    if (state.nextInterpretation && state.nextSkip > 0) state.nextSkip -= 1;
    else if (state.nextInterpretation) { const o = state.nextInterpretation; state.nextInterpretation = null; return send(200, wrap(o)); }
    const dm = /<documento>\n([\s\S]*?)\n<\/documento>/.exec(r.contents?.[0]?.parts?.[0]?.text ?? '');
    if (dm) return send(200, wrap(interpretInvoice(dm[1])));
    const m = /<mensaje>\n([\s\S]*?)\n<\/mensaje>/.exec(r.contents?.[0]?.parts?.[0]?.text ?? '');
    return send(200, wrap(interpret(m ? m[1] : '')));
  });
}).listen(3200, '0.0.0.0');
