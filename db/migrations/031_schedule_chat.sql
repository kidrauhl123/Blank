BEGIN;

-- 定时任务改为在对话里创建：先存成草稿（DRAFT），用户确认后才变成 ACTIVE。
-- 演示账户由访客共用，对话里创建的任务只属于创建它的访客；owner 为空的是旧数据，所有人可见。
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS visitor_owner_id UUID REFERENCES visitor_memory_owners(id);
ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_status_check;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_status_check
  CHECK (status IN ('DRAFT','ACTIVE','PAUSED','CANCELLED','COMPLETED','ERROR'));
CREATE INDEX IF NOT EXISTS scheduled_tasks_owner ON scheduled_tasks(visitor_owner_id) WHERE visitor_owner_id IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('031_schedule_chat.sql') ON CONFLICT DO NOTHING;
COMMIT;
