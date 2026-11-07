/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * URL base de la API (con prefijo /api/v1, SIN barra final).
   * Es una URL PÚBLICA, nunca un secreto. Ver GUIA_FRONTEND_NOTIHOUSE_PAL.md §12.3.
   */
  readonly VITE_API_BASE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
