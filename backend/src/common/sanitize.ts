const MAX_ERROR_LENGTH = 500;

const REDACTIONS: [RegExp, string][] = [
  // Credenciales en URLs: scheme://usuario:clave@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@'],
  [/\bBearer\s+\S+/gi, 'Bearer ***'],
  [
    /\b(authorization|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*)["']?[^\s"',;&]+/gi,
    '$1$2***',
  ],
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '***@***'],
  // Cadenas largas tipo token/clave (base64, hex).
  [/\b[A-Za-z0-9_\-+/]{32,}={0,2}/g, '***'],
];

/**
 * Mensaje de error de un componente externo apto para persistir: sin
 * caracteres de control, sin credenciales ni tokens aparentes y truncado.
 * Es una defensa adicional: el cliente no debe enviar secretos.
 */
export function sanitizeErrorMessage(message: string): string {
  // Eliminar caracteres de control es precisamente el objetivo de esta expresión.
  // oxlint-disable-next-line no-control-regex
  let result = message.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replace(/\s+/g, ' ').trim();
  return result.length > MAX_ERROR_LENGTH
    ? `${result.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : result;
}
