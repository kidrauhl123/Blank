BEGIN;
ALTER TABLE demo_profiles ADD COLUMN IF NOT EXISTS investment_seeded_at TIMESTAMPTZ;
INSERT INTO schema_migrations(version) VALUES('022_demo_investment_history.sql') ON CONFLICT DO NOTHING;
COMMIT;
