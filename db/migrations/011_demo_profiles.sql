BEGIN;
-- Mapping only. Fictional data is created once, on the first permitted profile selection.
CREATE TABLE IF NOT EXISTS demo_profiles (
  profile_key TEXT PRIMARY KEY,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id),
  seeded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES ('011_demo_profiles.sql') ON CONFLICT DO NOTHING;
COMMIT;
