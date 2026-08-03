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
