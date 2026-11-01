BEGIN;

-- 生活事件和偏好的记忆（记忆加强）：只存用户本人说过的事实，按访客隔离。
-- 事件（例如“下周五是我妈生日”）带日期，到期前在动态里提醒；偏好（例如“我在戒奶茶”）没有日期。
-- 删除是软删除：deleted_at 有值就不再用于回答和提醒。version 用于乐观并发：界面上的旧版本不能覆盖新的修改。
CREATE TABLE IF NOT EXISTS visitor_life_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'preference')),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 60),
  due_on DATE,
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT life_memory_due_matches_kind CHECK ((kind = 'event') = (due_on IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS visitor_life_memories_owner ON visitor_life_memories(customer_id, visitor_owner_id) WHERE deleted_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('037_life_memories.sql') ON CONFLICT DO NOTHING;
COMMIT;
