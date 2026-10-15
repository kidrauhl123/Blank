BEGIN;

ALTER TABLE app_agent_runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS ai_model TEXT;

INSERT INTO schema_migrations(version)
VALUES('014_app_agent_model.sql') ON CONFLICT DO NOTHING;

COMMIT;
