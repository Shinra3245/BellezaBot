-- Migración 001 (Fase 4): tabla de bloqueos de horario de la dueña.
-- Idempotente: segura de re-ejecutar sobre una BD que ya tiene el schema base.
CREATE TABLE IF NOT EXISTS blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blocks_business_date ON blocks (business_id, starts_at);
