BEGIN;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'SCHEDULED'
  CHECK (trigger_source IN ('SCHEDULED','MANUAL'));
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS manual_request_key UUID;
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_run_manual_request ON scheduled_task_runs(manual_request_key) WHERE manual_request_key IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES('024_review_recording_support.sql') ON CONFLICT DO NOTHING;
COMMIT;
