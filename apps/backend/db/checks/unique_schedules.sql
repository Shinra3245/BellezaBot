-- Comprobación de solo lectura para ejecutar después de la migración 003.
-- Resultado esperado:
--   1. La primera consulta devuelve una fila con validated = true.
--   2. La segunda consulta devuelve cero filas.

SELECT
  c.conname AS constraint_name,
  c.convalidated AS validated,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conname = 'schedules_business_day_time_key'
  AND c.conrelid = 'public.schedules'::regclass;

SELECT
  business_id,
  day_of_week,
  start_time,
  end_time,
  count(*) AS copies
FROM public.schedules
GROUP BY business_id, day_of_week, start_time, end_time
HAVING count(*) > 1
ORDER BY business_id, day_of_week, start_time;
