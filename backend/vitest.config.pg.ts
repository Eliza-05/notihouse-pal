import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Suite contra PostgreSQL 18 REAL y descartable (Fase 4.2F.2). No forma parte
 * de `npm test` ni de `npm run test:e2e`: exige `npm run conc:up` y
 * `npm run conc:init`, y aborta si el destino no supera target-guard.ts.
 *
 * Los archivos se ejecutan en serie: la cola de trabajos y el barrido de
 * alertas son globales. La concurrencia ocurre DENTRO de cada prueba.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/pg/**/*.pg-spec.ts'],
    setupFiles: ['./test/pg/setup-pg.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
