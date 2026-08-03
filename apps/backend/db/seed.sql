-- Datos de prueba para desarrollo. Idempotente: se puede re-ejecutar sin duplicar.
-- UUIDs fijos para poder referenciarlos desde pruebas y desde el panel demo.

-- Negocio demo
INSERT INTO businesses (id, name, wa_phone, wa_phone_number_id, owner_phone, timezone,
                        bot_name, bot_personality, tone, is_active, subscription_expiry)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Estética Demo',
  '+521000000001',              -- Número de WhatsApp del negocio (E.164)
  'DEMO_PHONE_NUMBER_ID',       -- MOCK: reemplazar con el phone_number_id real de Meta (Fase 1.4)
  '+521999999999',              -- Número de la dueña → activa el modo admin del bot
  'America/Mexico_City',
  'Bella',
  'amable y cercana',
  'informal',
  true,
  now() + interval '30 days'    -- Suscripción activa por 30 días
)
ON CONFLICT (id) DO NOTHING;

-- Servicios del negocio demo
INSERT INTO services (id, business_id, name, price, duration_minutes, is_active) VALUES
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'Manicure', 250.00, 45, true),
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', 'Pedicure', 300.00, 60, true),
  ('22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111111', 'Uñas acrílicas', 450.00, 90, true)
ON CONFLICT (id) DO NOTHING;

-- Horarios de atención: Lunes(1) a Sábado(6), 10:00–19:00 (0=Domingo cerrado)
INSERT INTO schedules (business_id, day_of_week, start_time, end_time)
SELECT '11111111-1111-1111-1111-111111111111', d, '10:00', '19:00'
FROM generate_series(1, 6) AS d
WHERE NOT EXISTS (
  SELECT 1 FROM schedules
  WHERE business_id = '11111111-1111-1111-1111-111111111111' AND day_of_week = d
);

-- Usuarios del panel.
-- password_hash es bcrypt real de la contraseña demo "password" (solo para desarrollo).
-- ⚠️ Cambiar estas credenciales antes del piloto real (ver PENDIENTES_MANUALES.md, Fase 5).
INSERT INTO users (id, business_id, email, password_hash, role) VALUES
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111',
   'duena@demo.com', '$2b$10$YUZU7PTXTA2nDkiGJDjmtupHPlPZ6eqc1Wzd0jpHkB2J3Vc4aScti', 'owner'),
  ('33333333-3333-3333-3333-333333333302', NULL,
   'admin@bellezabot.com', '$2b$10$YUZU7PTXTA2nDkiGJDjmtupHPlPZ6eqc1Wzd0jpHkB2J3Vc4aScti', 'superadmin')
ON CONFLICT (id) DO NOTHING;
