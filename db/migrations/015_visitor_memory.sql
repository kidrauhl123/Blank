BEGIN;

-- A visitor is a browser-held, server-issued bearer credential. Never store the
-- raw credential or use a shared demo customer as the preference owner.
CREATE TABLE IF NOT EXISTS visitor_memory_owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days')
);

CREATE TABLE IF NOT EXISTS visitor_memory_scopes (
  owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  profile_key TEXT NOT NULL REFERENCES demo_profiles(profile_key) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, profile_key)
);

CREATE TABLE IF NOT EXISTS visitor_memory_preferences (
  owner_id UUID NOT NULL,
  profile_key TEXT NOT NULL,
  preference_key TEXT NOT NULL CHECK (preference_key IN ('preferred_name', 'response_language', 'response_detail')),
  preference_value TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('USER_EXPLICIT', 'USER_SETTINGS')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, profile_key, preference_key),
  FOREIGN KEY (owner_id, profile_key) REFERENCES visitor_memory_scopes(owner_id, profile_key) ON DELETE CASCADE,
  CHECK (expires_at > updated_at),
  CHECK (
    (preference_key = 'preferred_name' AND char_length(preference_value) BETWEEN 1 AND 40 AND preference_value !~ '[[:cntrl:]]') OR
    (preference_key = 'response_language' AND preference_value IN ('zh-CN', 'en')) OR
    (preference_key = 'response_detail' AND preference_value IN ('brief', 'standard', 'detailed'))
  )
);

CREATE INDEX IF NOT EXISTS visitor_memory_preferences_expiry_idx ON visitor_memory_preferences(expires_at);
CREATE INDEX IF NOT EXISTS visitor_memory_owners_expiry_idx ON visitor_memory_owners(expires_at);

INSERT INTO schema_migrations(version) VALUES ('015_visitor_memory.sql') ON CONFLICT DO NOTHING;
COMMIT;
