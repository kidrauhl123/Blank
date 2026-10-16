BEGIN;

-- Persist replay protection across customers' operations and server restarts.
ALTER TABLE mfa_totp ADD COLUMN IF NOT EXISTS last_used_counter BIGINT NOT NULL DEFAULT -1;

INSERT INTO schema_migrations(version) VALUES ('015_totp_replay_protection.sql') ON CONFLICT DO NOTHING;

COMMIT;
