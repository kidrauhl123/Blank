BEGIN;
ALTER TABLE app_agent_runs ADD COLUMN IF NOT EXISTS memory_owner_id UUID REFERENCES visitor_memory_owners(id) ON DELETE SET NULL;
ALTER TABLE app_agent_runs ADD COLUMN IF NOT EXISTS memory_profile_key TEXT;
ALTER TABLE agent_runtime_runs ADD COLUMN IF NOT EXISTS memory_owner_id UUID REFERENCES visitor_memory_owners(id) ON DELETE SET NULL;
ALTER TABLE agent_runtime_runs ADD COLUMN IF NOT EXISTS memory_profile_key TEXT;
INSERT INTO schema_migrations(version) VALUES ('016_app_agent_memory_scope.sql') ON CONFLICT DO NOTHING;
COMMIT;
