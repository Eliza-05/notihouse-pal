/**
 * Inspección SEGURA del archivo local de credenciales demo
 * (`npm run demo:credentials:check`). Nunca imprime contraseñas.
 *
 * Motivo (Etapa 6): un comando ad hoc intentó "enmascarar" el archivo con una
 * expresión que buscaba la palabra "contraseña", pero el archivo usa columnas
 * separadas por tabulador (nombre, correo, contraseña) sin etiqueta, así que
 * la contraseña se mostró completa. Regla: el archivo de credenciales no se
 * lee con cat, sed, grep ni scripts improvisados; solo con este inspector,
 * que construye la salida desde cero con los campos permitidos (lista
 * blanca), en lugar de intentar ocultar lo prohibido (lista negra).
 */
import { readFileSync } from 'node:fs';
import { CREDENTIALS_FILE } from './local-script-support.js';

export interface CredentialsReport {
  accounts: { name: string; email: string; passwordLength: number }[];
  distinctPasswords: number;
  malformedLines: number;
}

const maskEmail = (email: string) =>
  email.replace(/^(.{2})[^@]*@(.).*?(\.[^.]+)$/, '$1***@$2***$3');

/** Solo nombre, correo enmascarado y longitud. La contraseña no sale de aquí. */
export function describeCredentials(text: string): CredentialsReport {
  const passwords = new Set<string>();
  const accounts: CredentialsReport['accounts'] = [];
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const [name, email, password] = line.split('\t');
    if (!name || !email || !password) {
      malformedLines += 1;
      continue;
    }
    passwords.add(password.trim());
    accounts.push({
      name: name.trim().slice(0, 60),
      email: maskEmail(email.trim()),
      passwordLength: password.trim().length,
    });
  }
  return { accounts, distinctPasswords: passwords.size, malformedLines };
}

if (process.argv[1]?.endsWith('demo-credentials-check.js')) {
  try {
    const report = describeCredentials(readFileSync(CREDENTIALS_FILE, 'utf8'));
    for (const a of report.accounts) {
      console.log(
        `· ${a.name} <${a.email}> contraseña de ${a.passwordLength} caracteres`,
      );
    }
    console.log(
      `Cuentas: ${report.accounts.length} · contraseñas distintas: ${report.distinctPasswords} · líneas mal formadas: ${report.malformedLines}`,
    );
    if (report.accounts.length > 1 && report.distinctPasswords === 1) {
      console.log(
        '⚠ Todas las cuentas comparten la misma contraseña: rota con npm run db:demo:rotate-passwords (coordinar con frontend).',
      );
    }
  } catch (error) {
    console.error(`✗ ${(error as Error).message.replace(/\t.*$/s, '')}`);
    process.exitCode = 1;
  }
}
