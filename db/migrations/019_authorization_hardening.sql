BEGIN;

ALTER TABLE mfa_totp ADD COLUMN IF NOT EXISTS last_used_step BIGINT;

CREATE TABLE IF NOT EXISTS mfa_auth_state (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE transfers ADD COLUMN IF NOT EXISTS authorization_expires_at TIMESTAMPTZ;
UPDATE transfers SET authorization_expires_at=prepared_at+interval '10 minutes'
WHERE authorization_expires_at IS NULL;
ALTER TABLE transfers ALTER COLUMN authorization_expires_at SET NOT NULL;
ALTER TABLE transfers ALTER COLUMN authorization_expires_at SET DEFAULT (clock_timestamp()+interval '10 minutes');

-- Old drafts lack the v2 binding of recipient, note and expiry. Invalidate them
-- once instead of silently authorizing their contents under a new fingerprint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='019_authorization_hardening.sql') THEN
    -- The previous verifier did not record consumption. Burn its entire active
    -- +/-1 window once so a pre-upgrade code cannot authorize a second payment.
    UPDATE mfa_totp SET last_used_step=floor(extract(epoch FROM clock_timestamp())/30)::bigint+1
    WHERE enabled_at IS NOT NULL AND last_used_step IS NULL;
    INSERT INTO audit_events(customer_id,event_type,actor_type,event_summary,operation_id,evidence)
    SELECT customer_id,'TRANSFER_AUTH_INVALIDATED','SYSTEM','授权规则升级，旧草稿已取消，资金未转出',operation_id,'{"reason":"AUTHORIZATION_V2"}'::jsonb
    FROM transfers WHERE status IN ('PREPARED','AWAITING_AUTH');
    UPDATE authorization_challenges SET status='CANCELLED'
    WHERE status='PENDING' AND operation_id IN
      (SELECT operation_id FROM transfers WHERE status IN ('PREPARED','AWAITING_AUTH'));
    UPDATE agent_tasks SET status='CANCELLED',updated_at=now()
    WHERE id IN (SELECT task_id FROM agent_runtime_runs WHERE operation_id IN
      (SELECT operation_id FROM transfers WHERE status IN ('PREPARED','AWAITING_AUTH')) AND status IN ('RUNNING','INTERRUPTED'));
    UPDATE agent_runtime_runs SET status='CANCELLED',interrupt_kind=NULL,completed_at=now(),updated_at=now(),
      final_reply=(coalesce(final_reply,'{}'::jsonb)-'operation') || '{"message":"授权规则升级，旧草稿已取消，资金未转出。请重新发起。"}'::jsonb
    WHERE operation_id IN (SELECT operation_id FROM transfers WHERE status IN ('PREPARED','AWAITING_AUTH'))
      AND status IN ('RUNNING','INTERRUPTED');
    UPDATE transfers SET status='CANCELLED',failure_code='AUTHORIZATION_V2_REQUIRED',version=version+1
    WHERE status IN ('PREPARED','AWAITING_AUTH');
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES('019_authorization_hardening.sql') ON CONFLICT DO NOTHING;
COMMIT;
