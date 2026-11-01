BEGIN;

-- 网点预约（本行业务与跨境）：取号和换汇预约。只是预约，不扣款、不改变余额、不进账本；按访客隔离。
-- DRAFT 是预览（30 分钟内有效，用户确认后才保存）；BOOKED 才有号码；CANCELLED 只改状态，不删除记录。
CREATE TABLE IF NOT EXISTS bank_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('QUEUE', 'FX')),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'BOOKED', 'CANCELLED')),
  branch_id TEXT NOT NULL CHECK (char_length(branch_id) BETWEEN 1 AND 40),
  detail JSONB NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  ticket TEXT CHECK (ticket IS NULL OR char_length(ticket) BETWEEN 1 AND 12),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  booked_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT reservation_draft_state CHECK (status <> 'DRAFT' OR (booked_at IS NULL AND ticket IS NULL AND cancelled_at IS NULL)),
  CONSTRAINT reservation_booked_state CHECK (status <> 'BOOKED' OR (booked_at IS NOT NULL AND ticket IS NOT NULL AND cancelled_at IS NULL)),
  CONSTRAINT reservation_cancelled_state CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS bank_reservations_owner ON bank_reservations(customer_id, visitor_owner_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('038_bank_reservations.sql') ON CONFLICT DO NOTHING;
COMMIT;
