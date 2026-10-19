BEGIN;
CREATE INDEX IF NOT EXISTS idx_audit_app_agent_run
  ON audit_events(customer_id, (evidence->>'runId'), created_at, id);
INSERT INTO schema_migrations(version) VALUES ('017_app_agent_timeline.sql') ON CONFLICT DO NOTHING;
COMMIT;
