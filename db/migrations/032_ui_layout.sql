BEGIN;

-- 生长式界面：每位访客自己的首页排布、底部导航和自定义页面（演示账户由访客共用，所以按访客隔离）。
-- 界面结构只能由用户确认后才改变：AI 提出方案写进 ui_proposals，用户在 APP 里点“应用”才生效。
CREATE TABLE IF NOT EXISTS ui_layouts (
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  layout JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, visitor_owner_id)
);

CREATE TABLE IF NOT EXISTS ui_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  page JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ui_pages_owner ON ui_pages(customer_id, visitor_owner_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ui_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('layout', 'page', 'remove-page')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPLIED', 'DISMISSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ui_proposals_owner ON ui_proposals(customer_id, visitor_owner_id, created_at DESC);

-- 用户想要、但现有积木表达不了的需求。AI 先用最接近的方式呈现，同时记在这里，供开发汇总、补新积木。
CREATE TABLE IF NOT EXISTS ui_unmet_needs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  need TEXT NOT NULL CHECK (char_length(need) BETWEEN 1 AND 200),
  closest TEXT NOT NULL DEFAULT '' CHECK (char_length(closest) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('032_ui_layout.sql') ON CONFLICT DO NOTHING;
COMMIT;
