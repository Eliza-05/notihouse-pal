-- NotiHouse-Pal — Privilegios mínimos del rol de aplicación
-- (Fase 4.2F.1: PREPARADO, NO EJECUTADO en Neon).
--
-- Idempotente: REVOKE/GRANT pueden repetirse. Ejecutar como propietario del
-- esquema DESPUÉS de cada migración que agregue tablas (no se usan
-- privilegios por defecto: cada tabla nueva se concede de forma explícita).
--
-- Inventario derivado del código (backend/src): ningún servicio borra filas,
-- trunca tablas, crea objetos ni lee el historial de migraciones.
-- `SELECT ... FOR UPDATE/SHARE` exige privilegio UPDATE sobre la tabla
-- bloqueada; en `documents` basta UPDATE sobre una columna inocua.

BEGIN;

-- 1. Punto de partida: nada.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM notihouse_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM notihouse_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM notihouse_app;
REVOKE CREATE ON SCHEMA public FROM notihouse_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO notihouse_app;

-- El historial de migraciones no es accesible para la aplicación.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA drizzle FROM notihouse_app';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM notihouse_app';
  END IF;
END
$$;

-- 2. Solo lectura: identidad, credenciales (login) y catálogo.
GRANT SELECT ON profiles, auth_accounts, providers, provider_payment_links
  TO notihouse_app;

-- 3. Datos de negocio y de proceso: lectura, alta y actualización (sin DELETE).
GRANT SELECT, INSERT, UPDATE ON
  properties,
  obligations,
  obligation_occurrences,
  rentals,
  rent_charges,
  contracts,
  cases,
  case_proposals,
  hitl_requests,
  workflow_jobs,
  alerts
  TO notihouse_app;

-- 4. Documentos: alta y lectura; UPDATE solo de `updated_at`, necesario para
--    el bloqueo FOR SHARE. `storage_key`, `sha256` y el propietario no se
--    pueden modificar.
GRANT SELECT, INSERT ON documents TO notihouse_app;
GRANT UPDATE (updated_at) ON documents TO notihouse_app;

-- 5. Registros append-only desde la aplicación.
GRANT SELECT, INSERT ON audit_events, proposal_applications TO notihouse_app;

COMMIT;
