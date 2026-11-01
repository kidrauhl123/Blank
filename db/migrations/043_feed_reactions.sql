BEGIN;

-- 动态的赞和踩（P0-4 遗留）：口味原来只在浏览器本地，现在记到服务端，交给 Jev 判断候选帖子时带上。
-- owner_key 是访客（有访客身份时）或 'customer'；同一个访客对同一条动态只有一个态度，改主意就覆盖。
CREATE TABLE IF NOT EXISTS feed_reactions (
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL CHECK (char_length(owner_key) BETWEEN 1 AND 64),
  post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL CHECK (reaction IN ('up', 'down')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, owner_key, post_id)
);

INSERT INTO schema_migrations(version) VALUES ('043_feed_reactions.sql') ON CONFLICT DO NOTHING;
COMMIT;
