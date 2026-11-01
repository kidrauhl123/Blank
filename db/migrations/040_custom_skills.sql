BEGIN;

-- 自定义做法（Skill Creator，P0-6）：用户本人在 App 里描述的做法，整理成 SKILL.md 预览，确认后保存。
-- 它只是说明书：只能组合现有工具，不能新增权限、免确认或绕过强验证；只属于创建它的访客（按访客隔离）。
-- DRAFT 是预览（30 分钟内有效）；ACTIVE 可以在对话里按名字触发；DISABLED 是停用但保留；DELETED 是软删除。
CREATE TABLE IF NOT EXISTS custom_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 12),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 80),
  when_to_use TEXT NOT NULL CHECK (char_length(when_to_use) BETWEEN 1 AND 160),
  steps JSONB NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 8),
  notes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notes) = 'array' AND jsonb_array_length(notes) <= 5),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'DISABLED', 'DELETED')),
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_at TIMESTAMPTZ,
  CONSTRAINT custom_skill_saved_state CHECK (status = 'DRAFT' OR saved_at IS NOT NULL)
);
-- 同一位访客保存中的做法名字不重复（草稿和已删除的不占名字）。
CREATE UNIQUE INDEX IF NOT EXISTS custom_skills_name_unique ON custom_skills(customer_id, visitor_owner_id, name) WHERE status IN ('ACTIVE', 'DISABLED');
CREATE INDEX IF NOT EXISTS custom_skills_owner ON custom_skills(customer_id, visitor_owner_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('040_custom_skills.sql') ON CONFLICT DO NOTHING;
COMMIT;
