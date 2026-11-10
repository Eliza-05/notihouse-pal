-- NotiHouse-Pal — Reversión del rol de aplicación (PREPARADO, NO EJECUTADO).
--
-- Usar SOLO después de volver a apuntar DATABASE_URL al rol anterior y
-- reiniciar el backend (ver docs/security/backend-security-review.md).
-- No toca datos ni el esquema: solo retira privilegios y el rol.

BEGIN;

ALTER ROLE notihouse_app NOLOGIN;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM notihouse_app;
REVOKE ALL ON SCHEMA public FROM notihouse_app;

-- Antes de DROP ROLE, terminar sesiones abiertas del rol (si las hay):
--   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'notihouse_app';
DROP ROLE IF EXISTS notihouse_app;

COMMIT;
