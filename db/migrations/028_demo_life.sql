BEGIN;

-- 展示账户的"生活模拟"进度：引擎按天回放并持续生成流水，simulated_through 是已完整模拟的最后一天（北京时间）。
CREATE TABLE IF NOT EXISTS demo_life_state (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  simulated_through DATE NOT NULL,
  -- 开始模拟前的订阅扣费日与理财估值日期，重置时恢复。
  original_business_date DATE,
  original_subscriptions JSONB NOT NULL DEFAULT '[]',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('028_demo_life.sql') ON CONFLICT DO NOTHING;
COMMIT;
