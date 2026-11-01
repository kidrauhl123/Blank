BEGIN;

-- 预算提醒（P0-6 预算规划）：某个分类本月花到上限的 80% 时发一次动态提醒，复用定时任务的执行、回执和动态流程。
-- 只有 BUDGET_CHECK 任务有分类和上限；其余任务这三列必须为空。budget_alert_month 记录本月已提醒，避免每天重复发。
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS budget_category TEXT CHECK (budget_category IS NULL OR char_length(budget_category) BETWEEN 1 AND 8);
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS budget_cap_minor BIGINT CHECK (budget_cap_minor IS NULL OR budget_cap_minor BETWEEN 100 AND 100000000);
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS budget_alert_month TEXT CHECK (budget_alert_month IS NULL OR budget_alert_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_kind_check;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_kind_check
  CHECK (kind IN ('REMINDER','MONTHLY_REPORT','SUBSCRIPTION_CHECK','DAILY_AI_REVIEW','BUDGET_CHECK'));
ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS budget_check_shape;
ALTER TABLE scheduled_tasks ADD CONSTRAINT budget_check_shape
  CHECK ((kind = 'BUDGET_CHECK') = (budget_category IS NOT NULL AND budget_cap_minor IS NOT NULL)
    AND (kind <> 'BUDGET_CHECK' OR frequency = 'DAILY')
    AND (kind = 'BUDGET_CHECK' OR budget_alert_month IS NULL));

INSERT INTO schema_migrations(version) VALUES ('039_budget_alerts.sql') ON CONFLICT DO NOTHING;
COMMIT;
