BEGIN;

-- 事件触发的动态检查：发生了新交易等事件时打上请求标记，下一次调度 tick 就检查一次，不等整点心跳。
ALTER TABLE feed_publisher_state ADD COLUMN IF NOT EXISTS check_requested_at TIMESTAMPTZ;

INSERT INTO schema_migrations(version) VALUES ('036_feed_check_requests.sql') ON CONFLICT DO NOTHING;
COMMIT;
