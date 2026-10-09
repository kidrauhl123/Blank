BEGIN;

-- Revoke credentials before removing retired runtime state. Fresh installs
-- no longer create these tables; existing audit and banking records are retained.
DO $$
BEGIN
  IF to_regclass('public.nanobot_runs') IS NOT NULL THEN
    UPDATE api_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE client_id IN (SELECT client_id FROM public.nanobot_runs);

    UPDATE api_clients
    SET status = 'REVOKED'
    WHERE id IN (SELECT client_id FROM public.nanobot_runs);
  END IF;
END;
$$;

DROP TABLE IF EXISTS public.nanobot_channel_messages;
DROP TABLE IF EXISTS public.nanobot_channels;
DROP TABLE IF EXISTS public.nanobot_runs;
DROP TABLE IF EXISTS public.nanobot_consents;

INSERT INTO schema_migrations(version)
VALUES ('009_retire_legacy_agent.sql') ON CONFLICT DO NOTHING;

COMMIT;
