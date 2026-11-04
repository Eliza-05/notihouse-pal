-- NotiHouse-Pal — Rol de aplicación (probado en PostgreSQL 18 local; NO EJECUTADO en Neon).
--
-- Crea el rol que usará NestJS en tiempo de ejecución (DATABASE_URL), separado
-- del rol propietario/migrador (`neondb_owner`), que queda reservado para
-- migraciones y scripts administrativos.
--
-- * NO contiene contraseñas. El rol se crea SIN LOGIN; la contraseña se asigna
--   después con `ALTER ROLE ... LOGIN PASSWORD`, sin guardarla en este archivo.
--   Neon no admite contraseñas con hash, así que `\password` de psql no sirve
--   (ver docs/deployment/mvp-demo-setup.md).
-- * Ejecutar como el rol propietario del esquema, en una transacción revisada.
-- * No es una migración de Drizzle: vive fuera de database/migrations a
--   propósito, para que `drizzle-kit migrate` nunca lo aplique por sí solo.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notihouse_app') THEN
    CREATE ROLE notihouse_app
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS
      CONNECTION LIMIT 20;
  END IF;
END
$$;

-- Límites de seguridad para cualquier sesión del rol.
ALTER ROLE notihouse_app SET statement_timeout = '30s';
ALTER ROLE notihouse_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE notihouse_app SET search_path = public;

COMMIT;
