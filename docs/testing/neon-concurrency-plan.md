# Plan de pruebas de concurrencia y uso de Neon

Actualizado en la Fase 4.2F.2. El plan de la Fase 4.2F.1 ya se ejecutó sobre un **PostgreSQL 18 local y descartable**. Procedimiento y resultados: [postgres-concurrency-results.md](postgres-concurrency-results.md).

## 1. Por qué hizo falta

PGlite es PostgreSQL real, pero con **una sola conexión**: las transacciones se serializan. Demuestra la lógica, no la contención entre conexiones independientes. La ejecución real encontró interbloqueos y una carrera en el plazo HITL que PGlite no podía mostrar.

## 2. Regla sobre Neon

Neon tiene una sola rama, `production`, con los datos demo y la auditoría append-only. Ninguna prueba de negocio se puede limpiar sin alterar el historial.

| Permitido en Neon | Prohibido en Neon |
|---|---|
| Conectividad de lectura | `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` |
| Esquema, migraciones y metadatos | `CREATE`, `ALTER`, `DROP`, migraciones |
| Conteos y resúmenes `md5` de solo lectura | Cambios de roles o contraseñas |
| Consultas HTTP de lectura | Cuentas, casos o trabajos de prueba |
| Comprobaciones de autenticación sin cambios | Confirmaciones, aplicaciones y alertas persistidas |
| | Pruebas de bloqueo, incluida `lock-probe` |

Esta fase **no** usó una rama temporal de Neon. La recomendación anterior de ejecutar en `production` o en una rama queda sustituida por esta regla.

## 3. Herramientas

| Herramienta | Uso | Salvaguarda |
|---|---|---|
| `src/database/scripts/concurrency/target-guard.ts` | Barrera de destino que falla en cerrado | Sin opción para forzarla |
| `generate-env.ts`, `init-disposable-db.ts` | Credenciales locales e inicialización | No leen `backend/.env` ni copian nada de Neon |
| `test/pg/*.pg-spec.ts` (`npm run conc:test`) | 183 pruebas sobre dos instancias Nest con pools propios | Pool verificado y rol `notihouse_app` |
| `run-with-api-processes.ts` + `scenarios.ts` (`npm run conc:suite`) | 10 escenarios sobre dos procesos reales | Entorno explícito, sin `.env`; se detiene en el primer fallo |
| `lock-probe.ts` | `SKIP LOCKED`, `NOWAIT` y liberación | Solo PostgreSQL descartable |
| `neon-readonly-snapshot.ts` | Huella antes y después | Sesión `default_transaction_read_only` y `BEGIN READ ONLY` |
| `test/concurrency-scenarios.e2e-spec.ts` | Lógica de los escenarios en PGlite | No demuestra contención |

## 4. Verificar que Neon no cambió

```bash
node --env-file=.env dist/database/scripts/concurrency/neon-readonly-snapshot.js > .local/concurrency/neon-after.json
```

Compara `overallSha256` con la huella tomada antes. No imprime datos: solo conteos y resúmenes.

## 5. Criterios para detener una ejecución

- Un escenario con un resultado distinto del esperado. Se analiza antes de reintentar.
- `deadlock detected` en el log del servidor, salvo en una prueba que reproduzca un defecto.
- Una barrera que no reúne las sesiones esperadas: esa carrera no cuenta como superada.
- La huella de Neon cambia.

## 6. Pendiente para fases posteriores

La contención a través del pooler de Neon y con su latencia sigue sin comprobarse. Hacerlo exige un entorno descartable en Neon, que es una decisión explícita y no se tomó en esta fase.
