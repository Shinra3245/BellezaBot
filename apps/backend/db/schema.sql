CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Negocios (tenants)
CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  wa_phone TEXT UNIQUE NOT NULL,          -- Número de WhatsApp del negocio (E.164)
  wa_phone_number_id TEXT UNIQUE,         -- phone_number_id de Meta para ese número
  owner_phone TEXT,                       -- Número personal de la dueña (E.164) → activa el modo admin del bot
  timezone TEXT NOT NULL DEFAULT 'America/Mexico_City',
  bot_name TEXT DEFAULT 'Asistente',
  bot_personality TEXT DEFAULT 'amable y profesional',
  tone TEXT DEFAULT 'informal',
  is_active BOOLEAN NOT NULL DEFAULT true,
  subscription_expiry TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usuarios del panel (dueñas y super-admin)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id),  -- NULL para superadmin
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                 -- bcrypt
  role TEXT NOT NULL CHECK (role IN ('owner','superadmin')),
  token_version INT NOT NULL DEFAULT 0,        -- Incrementar = revocar todos sus JWT
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Servicios del negocio
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  duration_minutes INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Horarios de atención
CREATE TABLE schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Domingo (convención JS Date.getDay())
  start_time TIME NOT NULL,
  end_time TIME NOT NULL
);

-- Citas
CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  service_id UUID NOT NULL REFERENCES services(id),
  client_phone TEXT NOT NULL,
  client_name TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,               -- starts_at + duración del servicio
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending','confirmed','rescheduled','cancelled','completed','no_show')),
  reminder_sent_at TIMESTAMPTZ,               -- Evita recordatorios duplicados
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bloqueos de horario (la dueña marca rangos no disponibles: descansos, vacaciones, etc.)
-- check_availability los respeta igual que una cita ocupada.
CREATE TABLE blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversaciones (una por cliente-negocio)
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  client_phone TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',   -- Futuro: instagram, messenger
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, client_phone, channel)
);

-- Mensajes (memoria del bot)
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  wa_message_id TEXT UNIQUE,                  -- ID de Meta → idempotencia ante reintentos
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para consultas frecuentes
CREATE INDEX idx_appointments_business_date ON appointments (business_id, starts_at);
CREATE INDEX idx_appointments_reminders ON appointments (starts_at) WHERE status = 'confirmed' AND reminder_sent_at IS NULL;
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX idx_conversations_lookup ON conversations (business_id, client_phone);
CREATE INDEX idx_blocks_business_date ON blocks (business_id, starts_at);

-- Seguridad de la Data API de Supabase.
-- El navegador nunca accede directamente a estas tablas: todo pasa por el backend.
-- El rol PostgreSQL propietario que usa el backend conserva su acceso, mientras que
-- los roles públicos de Supabase quedan sin acceso directo.
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- PUBLIC es un rol implícito de PostgreSQL; retirar solo anon/authenticated no basta
-- si PUBLIC todavía puede usar el esquema.
REVOKE USAGE ON SCHEMA public FROM PUBLIC;

-- Los roles anon/authenticated existen en Supabase, pero no necesariamente en la
-- base PostgreSQL local usada para desarrollo.
DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated';
  END IF;
END
$security$;
