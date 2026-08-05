-- Migración 003: impide horarios exactamente duplicados para el mismo negocio.
--
-- Antes de crear la restricción aborta con un mensaje claro si todavía existen
-- duplicados, para que nunca elimine datos silenciosamente.
-- Idempotente: se puede volver a ejecutar si la restricción ya existe.

BEGIN;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.schedules
    GROUP BY business_id, day_of_week, start_time, end_time
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'No se puede crear schedules_business_day_time_key: todavía existen horarios duplicados';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'schedules_business_day_time_key'
      AND conrelid = 'public.schedules'::regclass
  ) THEN
    ALTER TABLE public.schedules
      ADD CONSTRAINT schedules_business_day_time_key
      UNIQUE (business_id, day_of_week, start_time, end_time);
  END IF;
END
$migration$;

COMMIT;
