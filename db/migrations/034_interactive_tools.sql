BEGIN;

-- 当场造的交互小工具（滑块模拟器、分账表）。规格是模型填的参数，已经过 tool-spec.ts 的校验；
-- 每位访客各自的小工具，保存到首页只是记下 saved_at，首页布局由 ui-store 另外写。
CREATE TABLE IF NOT EXISTS interactive_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('slider-simulator', 'split-table')),
  spec JSONB NOT NULL,
  saved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interactive_tools_owner ON interactive_tools(customer_id, visitor_owner_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('034_interactive_tools.sql') ON CONFLICT DO NOTHING;
COMMIT;
