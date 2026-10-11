BEGIN;

-- Keep credential metadata and invocation history for audit, but move them out
-- of the former live namespace. Foreign keys follow the table renames.
DO $$
BEGIN
  IF to_regclass('public.api_tokens') IS NOT NULL THEN
    UPDATE api_tokens SET revoked_at=coalesce(revoked_at,now()),
      expires_at=least(expires_at,now());
    ALTER TABLE api_tokens RENAME TO retired_api_tokens;
  END IF;
  IF to_regclass('public.api_clients') IS NOT NULL THEN
    UPDATE api_clients SET status='REVOKED';
    ALTER TABLE api_clients RENAME TO retired_api_clients;
  END IF;
  IF to_regclass('public.mcp_invocations') IS NOT NULL THEN
    ALTER TABLE mcp_invocations RENAME TO external_access_history;
  END IF;
END;
$$;

ALTER TABLE retired_api_tokens DROP CONSTRAINT IF EXISTS retired_token_revoked;
ALTER TABLE retired_api_tokens ADD CONSTRAINT retired_token_revoked CHECK (revoked_at IS NOT NULL);
ALTER TABLE retired_api_clients DROP CONSTRAINT IF EXISTS retired_client_revoked;
ALTER TABLE retired_api_clients ADD CONSTRAINT retired_client_revoked CHECK (status='REVOKED');

-- Preserve old MCP task records and checkpoints, but close any unfinished run.
UPDATE agent_tasks SET status='CANCELLED',updated_at=now()
WHERE id IN (SELECT task_id FROM agent_runtime_runs WHERE channel_type='MCP' AND status IN ('RUNNING','INTERRUPTED'));
UPDATE agent_runtime_runs SET status='CANCELLED',completed_at=coalesce(completed_at,now()),updated_at=now()
WHERE channel_type='MCP' AND status IN ('RUNNING','INTERRUPTED');
UPDATE agent_threads SET status='CLOSED',updated_at=now()
WHERE channel_type='MCP' AND status='ACTIVE';

-- NOT VALID retains historical rows while rejecting new retired-channel rows.
ALTER TABLE agent_threads DROP CONSTRAINT IF EXISTS agent_threads_channel_type_check;
ALTER TABLE agent_threads ADD CONSTRAINT agent_threads_channel_type_check
  CHECK (channel_type IN ('PWA','WECOM','QQ')) NOT VALID;
ALTER TABLE agent_runtime_runs DROP CONSTRAINT IF EXISTS agent_runtime_runs_channel_type_check;
ALTER TABLE agent_runtime_runs ADD CONSTRAINT agent_runtime_runs_channel_type_check
  CHECK (channel_type IN ('PWA','WECOM','QQ')) NOT VALID;

INSERT INTO schema_migrations(version)
VALUES('013_retire_external_access.sql') ON CONFLICT DO NOTHING;

COMMIT;
