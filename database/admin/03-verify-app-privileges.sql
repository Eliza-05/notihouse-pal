-- NotiHouse-Pal — Verificación de privilegios del rol de aplicación.
-- Solo lectura: puede ejecutarse en cualquier momento (también antes de crear
-- el rol: en ese caso devuelve `role_exists = false`).
--
-- Resultado esperado: ninguna fila con `ok = false`.

WITH expected(table_name, sel, ins, upd, del) AS (
  VALUES
    ('profiles',               true,  false, false, false),
    ('auth_accounts',          true,  false, false, false),
    ('providers',              true,  false, false, false),
    ('provider_payment_links', true,  false, false, false),
    ('properties',             true,  true,  true,  false),
    ('obligations',            true,  true,  true,  false),
    ('obligation_occurrences', true,  true,  true,  false),
    ('rentals',                true,  true,  true,  false),
    ('rent_charges',           true,  true,  true,  false),
    ('contracts',              true,  true,  true,  false),
    ('cases',                  true,  true,  true,  false),
    ('case_proposals',         true,  true,  true,  false),
    ('hitl_requests',          true,  true,  true,  false),
    ('workflow_jobs',          true,  true,  true,  false),
    ('alerts',                 true,  true,  true,  false),
    ('documents',              true,  true,  false, false),
    ('audit_events',           true,  true,  false, false),
    ('proposal_applications',  true,  true,  false, false)
),
role AS (
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notihouse_app') AS role_exists
)
SELECT e.table_name,
       role.role_exists,
       has_table_privilege('notihouse_app', 'public.' || e.table_name, 'SELECT') AS can_select,
       has_table_privilege('notihouse_app', 'public.' || e.table_name, 'INSERT') AS can_insert,
       has_table_privilege('notihouse_app', 'public.' || e.table_name, 'UPDATE') AS can_update,
       has_table_privilege('notihouse_app', 'public.' || e.table_name, 'DELETE') AS can_delete,
       has_table_privilege('notihouse_app', 'public.' || e.table_name, 'TRUNCATE') AS can_truncate,
       (has_table_privilege('notihouse_app', 'public.' || e.table_name, 'SELECT') = e.sel
        AND has_table_privilege('notihouse_app', 'public.' || e.table_name, 'INSERT') = e.ins
        AND has_table_privilege('notihouse_app', 'public.' || e.table_name, 'UPDATE') = e.upd
        AND has_table_privilege('notihouse_app', 'public.' || e.table_name, 'DELETE') = e.del
        AND NOT has_table_privilege('notihouse_app', 'public.' || e.table_name, 'TRUNCATE')
        AND NOT has_table_privilege('notihouse_app', 'public.' || e.table_name, 'TRIGGER')
        AND NOT has_table_privilege('notihouse_app', 'public.' || e.table_name, 'REFERENCES')) AS ok
FROM expected e, role
WHERE role.role_exists
ORDER BY ok, e.table_name;
