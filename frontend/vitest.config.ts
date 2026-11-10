import { defineConfig } from 'vitest/config'

// Pruebas unitarias de lógica pura del frontend (sin DOM). La URL de API es ficticia.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: { VITE_API_BASE_URL: 'http://localhost:3999/api/v1' },
  },
})
