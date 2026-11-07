import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Puerto fijo: es el único origen que la API de Render admite hoy en CORS
    // (ver docs/frontend/GUIA_FRONTEND_NOTIHOUSE_PAL.md §12.4). No cambiar sin
    // coordinar con el responsable del backend.
    port: 5173,
    strictPort: true,
  },
})
