BEGIN;

-- 卡片配方：用户和 AI 在对话里一起设计的动态卡片。配方只描述数据范围、积木与节奏，数字由服务端按账本计算。
-- 演示账户由访客共用，配方只属于创建它的访客。
CREATE TABLE IF NOT EXISTS feed_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visitor_owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  recipe JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feed_recipes_status CHECK (status IN ('DRAFT', 'ACTIVE', 'DELETED'))
);
CREATE INDEX IF NOT EXISTS feed_recipes_active ON feed_recipes(customer_id) WHERE status='ACTIVE';

-- 由配方发布的帖子只给创建它的访客看；系统帖子的这两列为空。
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS visitor_owner_id UUID REFERENCES visitor_memory_owners(id) ON DELETE CASCADE;
ALTER TABLE feed_posts ADD COLUMN IF NOT EXISTS recipe_id UUID REFERENCES feed_recipes(id) ON DELETE CASCADE;

INSERT INTO schema_migrations(version) VALUES ('029_feed_recipes.sql') ON CONFLICT DO NOTHING;
COMMIT;
