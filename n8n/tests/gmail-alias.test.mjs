/**
 * Pruebas UNITARIAS de la resolución estricta del alias de entrega (sin Docker, sin red, sin Gmail).
 * Cubre la matriz de seguridad: un mensaje solo se asigna a un alias si dos señales independientes
 * (etiqueta de Gmail y primer Delivered-To) coinciden y To/Cc no la contradicen; todo lo demás se rechaza.
 * Uso: node n8n/tests/gmail-alias.test.mjs
 */
import { resolveDelivery } from './lib/gmail-alias.mjs';

let ok = 0; let bad = 0;
const check = (name, cond, detail = '') => { if (cond) { ok += 1; console.log(`OK  ${name}`); } else { bad += 1; console.log(`ERR ${name} ${detail}`); } };

const BASE = 'notihousepal@gmail.com';
const CAMILA = 'notihousepal+camila@gmail.com';
const DANIEL = 'notihousepal+daniel@gmail.com';
const LABELS = { L1: 'nh-camila', L2: 'nh-daniel', L3: 'INBOX', L4: 'notihouse-facturas-prueba' };
const h = (name, value) => ({ name, value });

/** Mensaje válido para Camila; cada prueba lo modifica solo en lo que quiere comprobar. */
const msg = (over = {}) => ({
  headers: [h('From', 'Proveedor <proveedor@ejemplo.test>'), h('Delivered-To', CAMILA), h('To', CAMILA), h('Subject', 'Factura')],
  labelIds: ['L1', 'L3'],
  labelNames: LABELS,
  expectedAlias: CAMILA,
  expectedLabel: 'nh-camila',
  labelPrefix: 'nh-',
  ...over,
});
const without = (headers, ...names) => headers.filter((x) => !names.includes(x.name.toLowerCase()));
const run = (over) => resolveDelivery(msg(over));
const rejects = (name, over, reason) => { const r = run(over); check(`${name} → rechazo «${reason}»`, r.ok === false && r.reason === reason, JSON.stringify(r)); };

// ---- aceptación
{
  const r = run();
  check('Camila: Delivered-To y To con su alias y etiqueta nh-camila → acepta', r.ok === true && r.mailbox === CAMILA, JSON.stringify(r));
  check('La dirección devuelta es la ESPERADA de la configuración, no texto del mensaje', r.mailbox === CAMILA);
}
{
  const r = run({ headers: [h('Delivered-To', DANIEL), h('To', DANIEL)], labelIds: ['L2'], expectedAlias: DANIEL, expectedLabel: 'nh-daniel' });
  check('Daniel: su alias y su etiqueta → acepta y devuelve el alias de Daniel', r.ok === true && r.mailbox === DANIEL, JSON.stringify(r));
}
{
  const r = run({ headers: [h('Delivered-To', CAMILA), h('To', 'Otra Persona <otra@ejemplo.test>')] });
  check('Bcc: alias solo en Delivered-To (To ajeno), con etiqueta coherente → acepta', r.ok === true && r.evidencia.enDestinatarios === false, JSON.stringify(r));
}
{
  const r = run({ headers: [h('delivered-to', 'NotiHousePal+CAMILA@Gmail.com'), h('TO', '"Equipo" <NOTIHOUSEPAL+Camila@gmail.com>')] });
  check('Mayúsculas en nombres de cabecera y direcciones → se normalizan y acepta', r.ok === true && r.mailbox === CAMILA, JSON.stringify(r));
}
{
  const r = run({ headers: [h('Delivered-To', 'notiho.usepal+camila@googlemail.com'), h('To', CAMILA)] });
  check('Puntos en la parte local y googlemail.com (misma bandeja de Gmail) → acepta', r.ok === true && r.mailbox === CAMILA, JSON.stringify(r));
}
{
  const r = run({ headers: [h('Delivered-To', CAMILA), h('Delivered-To', 'reenvio@otro.test'), h('Delivered-To', CAMILA), h('To', CAMILA)] });
  check('Delivered-To ajenos adicionales (reenvío) o repetidos iguales se ignoran → acepta', r.ok === true, JSON.stringify(r));
}

// ---- rechazos de seguridad
rejects('Alias de Daniel en el primer Delivered-To (workflow de Camila)', { headers: [h('Delivered-To', DANIEL), h('To', DANIEL)] }, 'alias_distinto');
rejects('Alias desconocido (+otro)', { headers: [h('Delivered-To', 'notihousepal+otro@gmail.com'), h('To', 'notihousepal+otro@gmail.com')] }, 'alias_distinto');
rejects('Solo la dirección general (sin alias): nunca se convierte en caso de Camila', { headers: [h('Delivered-To', BASE), h('To', BASE)] }, 'direccion_general');
rejects('Delivered-To con «+» vacío', { headers: [h('Delivered-To', 'notihousepal+@gmail.com'), h('To', CAMILA)] }, 'alias_malformado');
rejects('Sin Delivered-To (aunque To tenga el alias)', { headers: [h('To', CAMILA)] }, 'sin_delivered_to');
rejects('To falso con el alias de Camila pero Delivered-To de Daniel', { headers: [h('Delivered-To', DANIEL), h('To', CAMILA)] }, 'alias_distinto');
rejects('Delivered-To de Camila pero To con el alias de Daniel (contradicción)', { headers: [h('Delivered-To', CAMILA), h('To', DANIEL)] }, 'destinatarios_contradictorios');
rejects('Dos aliases: To de Camila y Cc de Daniel', { headers: [h('Delivered-To', CAMILA), h('To', CAMILA), h('Cc', DANIEL)] }, 'destinatarios_contradictorios');
rejects('To con el alias de Camila y la dirección general', { headers: [h('Delivered-To', CAMILA), h('To', `${CAMILA}, ${BASE}`)] }, 'destinatarios_contradictorios');
rejects('Varios Delivered-To propios con alias distintos', { headers: [h('Delivered-To', CAMILA), h('Delivered-To', DANIEL), h('To', CAMILA)] }, 'delivered_to_contradictorio');
rejects('Delivered-To con dos direcciones en un mismo encabezado', { headers: [h('Delivered-To', `${CAMILA}, ${DANIEL}`), h('To', CAMILA)] }, 'delivered_to_no_propio');
rejects('Primer Delivered-To de otra cuenta (reenvío automático)', { headers: [h('Delivered-To', 'reenvio@otro.test'), h('Delivered-To', CAMILA), h('To', CAMILA)] }, 'delivered_to_no_propio');
rejects('Delivered-To de otra cuenta de Gmail (misma forma, otra bandeja)', { headers: [h('Delivered-To', 'otrabandeja+camila@gmail.com'), h('To', CAMILA)] }, 'delivered_to_no_propio');
rejects('Encabezado To duplicado', { headers: [h('Delivered-To', CAMILA), h('To', CAMILA), h('To', CAMILA)] }, 'encabezados_duplicados');
rejects('Encabezado Cc duplicado', { headers: [h('Delivered-To', CAMILA), h('Cc', 'a@ejemplo.test'), h('Cc', 'b@ejemplo.test')] }, 'encabezados_duplicados');
rejects('Dirección malformada en el nombre visible apuntando a Daniel', { headers: [h('Delivered-To', CAMILA), h('To', `"${DANIEL}" <alias@ejemplo.test>`)] }, 'destinatarios_contradictorios');
rejects('Sin encabezados', { headers: [] }, 'sin_delivered_to');
rejects('Encabezados inexistentes (null)', { headers: null }, 'sin_delivered_to');

// ---- etiquetas
rejects('Etiqueta esperada ausente', { labelIds: ['L3'] }, 'etiqueta_ausente');
rejects('Etiqueta de otro alias (nh-daniel) en lugar de nh-camila', { labelIds: ['L2'] }, 'etiqueta_ausente');
rejects('Ambas etiquetas nh-camila y nh-daniel en el mismo mensaje', { labelIds: ['L1', 'L2'] }, 'etiqueta_incoherente');
{
  const r = run({ labelIds: ['L1', 'L4'] });
  check('Etiqueta histórica ajena al prefijo (notihouse-facturas-prueba) no interfiere', r.ok === true, JSON.stringify(r));
}
rejects('Identificadores de etiqueta desconocidos', { labelIds: ['X9'] }, 'etiqueta_ausente');
rejects('Sin etiquetas', { labelIds: [] }, 'etiqueta_ausente');

// ---- configuración defectuosa: nunca acepta
rejects('Alias esperado sin sufijo (dirección general)', { expectedAlias: BASE }, 'configuracion_invalida');
rejects('Alias esperado vacío', { expectedAlias: '' }, 'configuracion_invalida');
rejects('Etiqueta esperada vacía', { expectedLabel: '' }, 'configuracion_invalida');

// ---- propiedades
{
  // Ninguna combinación de un solo cambio sobre el mensaje válido de Camila puede ser aceptada para DANIEL.
  const daniel = { expectedAlias: DANIEL, expectedLabel: 'nh-daniel' };
  const variants = [msg(), msg({ headers: [h('Delivered-To', CAMILA), h('To', DANIEL)] }), msg({ headers: [h('Delivered-To', BASE), h('To', DANIEL)] }), msg({ labelIds: ['L1', 'L2'] }), msg({ labelIds: ['L1'] })];
  const leaks = variants.filter((v) => resolveDelivery({ ...v, ...daniel }).ok === true);
  check('Ningún mensaje etiquetado y entregado a Camila se acepta para Daniel', leaks.length === 0, JSON.stringify(leaks.length));
  const resolveBoth = (m) => [resolveDelivery({ ...m, expectedAlias: CAMILA, expectedLabel: 'nh-camila' }).ok, resolveDelivery({ ...m, expectedAlias: DANIEL, expectedLabel: 'nh-daniel' }).ok];
  const both = [msg(), msg({ headers: [h('Delivered-To', DANIEL), h('To', DANIEL)], labelIds: ['L2'] }), msg({ headers: [h('Delivered-To', BASE)], labelIds: ['L1', 'L2'] })]
    .filter((m) => resolveBoth(m).every(Boolean));
  check('Ningún mensaje puede ser aceptado a la vez por el alias de Camila y el de Daniel', both.length === 0, String(both.length));
}
{
  const f = resolveDelivery.toString();
  check('La función es autocontenida (se incrusta tal cual en n8n): sin import, require ni referencias externas', !/\bimport\b|\brequire\(/.test(f) && f.startsWith('function resolveDelivery'));
}

console.log(bad ? `\nFALLARON ${bad} de ${ok + bad}` : `\nTodo correcto: ${ok} comprobaciones`);
process.exitCode = bad ? 1 : 0;
