BEGIN;

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  request_key UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('REMINDER','MONTHLY_REPORT','SUBSCRIPTION_CHECK')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  message TEXT NOT NULL DEFAULT '' CHECK (length(message)<=500),
  frequency TEXT NOT NULL CHECK (frequency IN ('ONCE','DAILY','WEEKLY','MONTHLY')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai' CHECK (timezone='Asia/Shanghai'),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL,
  retry_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','CANCELLED','COMPLETED','ERROR')),
  channel_identity_id UUID REFERENCES channel_identities(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(customer_id,request_key),
  CHECK (ends_at IS NULL OR ends_at>=starts_at)
);
CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(next_run_at) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS scheduled_tasks_customer ON scheduled_tasks(customer_id,created_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES scheduled_tasks(id),
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  summary TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(schedule_id,scheduled_for)
);
CREATE TABLE IF NOT EXISTS scheduler_heartbeat (
  id INTEGER PRIMARY KEY CHECK (id=1),
  last_tick_at TIMESTAMPTZ NOT NULL
);

INSERT INTO schema_migrations(version) VALUES ('020_scheduled_tasks.sql') ON CONFLICT DO NOTHING;
COMMIT;
