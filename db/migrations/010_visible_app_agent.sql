BEGIN;
CREATE TABLE IF NOT EXISTS app_agent_runs (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id),
  session_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  control_granted BOOLEAN NOT NULL DEFAULT false,
  pending JSONB,
  message TEXT NOT NULL DEFAULT '',
  steps INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '20 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_agent_status CHECK (status IN ('RUNNING','CONSENT','ACTION','QUESTION','HANDOFF','PAUSED','COMPLETED','CANCELLED','FAILED'))
);
CREATE INDEX IF NOT EXISTS app_agent_customer_idx ON app_agent_runs(customer_id, created_at DESC);
INSERT INTO schema_migrations(version) VALUES ('010_visible_app_agent.sql') ON CONFLICT DO NOTHING;
COMMIT;
