BEGIN;

CREATE INDEX IF NOT EXISTS idx_transfers_customer_executed
  ON transfers(customer_id, executed_at) WHERE status='SUCCEEDED';

INSERT INTO schema_migrations(version)
VALUES('012_transfer_daily_quota.sql') ON CONFLICT DO NOTHING;

COMMIT;
