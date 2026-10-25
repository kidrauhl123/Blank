BEGIN;
ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_kind_check;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_kind_check
  CHECK (kind IN ('REMINDER','MONTHLY_REPORT','SUBSCRIPTION_CHECK','DAILY_AI_REVIEW'));
ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS daily_ai_review_frequency_check;
ALTER TABLE scheduled_tasks ADD CONSTRAINT daily_ai_review_frequency_check
  CHECK (kind<>'DAILY_AI_REVIEW' OR frequency='DAILY');
ALTER TABLE scheduled_task_runs DROP CONSTRAINT IF EXISTS scheduled_task_runs_status_check;
ALTER TABLE scheduled_task_runs ADD CONSTRAINT scheduled_task_runs_status_check
  CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','SKIPPED','FAILED','CANCELLED'));
CREATE TABLE IF NOT EXISTS scheduled_ai_reviews (
  run_id UUID PRIMARY KEY REFERENCES scheduled_task_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','ERROR','CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token UUID,
  locked_until TIMESTAMPTZ,
  retry_at TIMESTAMPTZ,
  snapshot JSONB,
  gate JSONB,
  main_requested_at TIMESTAMPTZ,
  result JSONB,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_ai_reviews_pending ON scheduled_ai_reviews(updated_at)
  WHERE status IN ('PENDING','RUNNING');
INSERT INTO schema_migrations(version) VALUES('023_daily_ai_reviews.sql') ON CONFLICT DO NOTHING;
COMMIT;
