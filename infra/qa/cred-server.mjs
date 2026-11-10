// Servidor LOCAL temporal (127.0.0.1:3999) que entrega credenciales QA a la automatización del navegador
// sin imprimirlas. GET /<daniel|other|andres>. Uso: node --env-file=.local/qa/qa.env infra/qa/cred-server.mjs
import http from 'node:http';
const e = process.env;
const m = { daniel: [e.QA_USER_EMAIL_DANIEL, e.QA_USER_PASSWORD_DANIEL], other: [e.QA_USER_EMAIL_OTHER, e.QA_USER_PASSWORD_OTHER], andres: [e.QA_USER_EMAIL_ANDRES, e.QA_USER_PASSWORD_ANDRES] };
http.createServer((q, s) => {
  const k = q.url.slice(1);
  s.setHeader('Access-Control-Allow-Origin', '*');
  if (!m[k]) { s.statusCode = 404; return s.end(); }
  s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ email: m[k][0], password: m[k][1] }));
}).listen(3999, '127.0.0.1');
