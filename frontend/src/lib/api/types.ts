/**
 * Tipos del contrato de la API, tomados de
 * docs/frontend/GUIA_FRONTEND_NOTIHOUSE_PAL.md (§6 y §11.3).
 *
 * Reglas que NO hay que romper al extender este archivo (ver §4 y §10.5 de la guía):
 * - El dinero viaja como TEXTO decimal ("145000.00"), nunca como number.
 *   No convertir con Number()/parseFloat ni operar aritméticamente sobre él.
 * - Las fechas de calendario viajan como "YYYY-MM-DD" (sin hora ni zona).
 *   No construir con `new Date('YYYY-MM-DD')` directo: se interpreta como UTC
 *   y puede mostrar el día anterior según la zona del navegador.
 * - Los instantes (createdAt, updatedAt, dueAt, ...) son ISO 8601 completo.
 */

/** "145000.00" — nunca convertir a number para operar. */
export type MoneyString = string

/** "YYYY-MM-DD" — fecha de calendario, sin componente de hora/zona. */
export type CalendarDate = string

/** ISO 8601 completo (instante). */
export type IsoInstant = string

/** Envoltorio de paginación que usan todos los listados (`page`, `pageSize`, `total`). */
export interface Page<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

// ---------------------------------------------------------------------------
// Autenticación (§6.1, §7)
// ---------------------------------------------------------------------------

export interface LoginRequest {
  email: string
  password: string
}

export interface AuthenticatedUser {
  id: string
  email: string
  displayName: string | null
}

export interface LoginResponse {
  accessToken: string
  tokenType: 'Bearer'
  /** Segundos de validez desde el momento de la respuesta (hoy, 1800 = 30 min). */
  expiresIn: number
  user: AuthenticatedUser
}

// ---------------------------------------------------------------------------
// Formas de error que puede devolver el backend (ver §11.6)
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  statusCode?: number
  /** Puede ser un string único o una lista (errores de validación por campo). */
  message?: string | string[]
  error?: string
}
