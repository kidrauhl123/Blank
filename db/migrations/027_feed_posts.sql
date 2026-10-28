BEGIN;

-- 动态帖子：由后台按账本事实发布，每条保存发布当时的图表数据与引用的事实编号。
-- dedupe_key 决定发帖节奏，例如每周一次的消费日历、每笔异常只发一次。
CREATE TABLE IF NOT EXISTS feed_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  attention BOOLEAN NOT NULL DEFAULT false,
  chart JSONB NOT NULL,
  fact_ids TEXT[] NOT NULL DEFAULT '{}',
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feed_posts_dedupe UNIQUE (customer_id, dedupe_key),
  CONSTRAINT feed_posts_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT feed_posts_body_length CHECK (char_length(body) <= 600)
);
CREATE INDEX IF NOT EXISTS feed_posts_customer_published ON feed_posts(customer_id, published_at DESC);

-- 每位客户最近一次检查是否有新帖的时间，避免调度器每 15 秒都重新计算。
CREATE TABLE IF NOT EXISTS feed_publisher_state (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL
);

INSERT INTO schema_migrations(version) VALUES ('027_feed_posts.sql') ON CONFLICT DO NOTHING;
COMMIT;
