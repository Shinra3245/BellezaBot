-- Comprobación de solo lectura para ejecutar después de la migración 002.
-- Resultado esperado:
--   1. Las ocho filas de la primera consulta muestran rls_enabled = true.
--   2. Las columnas de permisos de la segunda consulta muestran false.
--   3. La tercera consulta muestra false para ambos roles.
--   4. La última consulta devuelve cero filas.

SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'appointments',
    'blocks',
    'businesses',
    'conversations',
    'messages',
    'schedules',
    'services',
    'users'
  )
ORDER BY c.relname;

WITH protected_tables(table_name) AS (
  VALUES
    ('appointments'),
    ('blocks'),
    ('businesses'),
    ('conversations'),
    ('messages'),
    ('schedules'),
    ('services'),
    ('users')
), api_roles(role_name) AS (
  VALUES ('anon'), ('authenticated')
)
SELECT
  t.table_name,
  r.role_name,
  has_table_privilege(r.role_name, format('public.%I', t.table_name), 'SELECT') AS can_select,
  has_table_privilege(r.role_name, format('public.%I', t.table_name), 'INSERT') AS can_insert,
  has_table_privilege(r.role_name, format('public.%I', t.table_name), 'UPDATE') AS can_update,
  has_table_privilege(r.role_name, format('public.%I', t.table_name), 'DELETE') AS can_delete,
  has_table_privilege(r.role_name, format('public.%I', t.table_name), 'TRUNCATE') AS can_truncate
FROM protected_tables t
CROSS JOIN api_roles r
ORDER BY t.table_name, r.role_name;

SELECT
  role_name,
  has_schema_privilege(role_name, 'public', 'USAGE') AS can_use_public_schema
FROM (VALUES ('anon'), ('authenticated')) AS api_roles(role_name)
ORDER BY role_name;

SELECT
  pg_get_userbyid(d.defaclrole) AS object_owner,
  d.defaclobjtype AS object_type,
  grantee.rolname AS grantee,
  privilege.privilege_type
FROM pg_default_acl d
CROSS JOIN LATERAL aclexplode(d.defaclacl) AS privilege
JOIN pg_roles grantee ON grantee.oid = privilege.grantee
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public'
  AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND grantee.rolname IN ('anon', 'authenticated')
ORDER BY object_owner, object_type, grantee, privilege_type;
