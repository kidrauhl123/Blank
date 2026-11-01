BEGIN;

-- 访客自己填写的模型接口（自定义 API key）。按访客保存，不按共享的模拟账户保存。
-- 密钥只以 AES-256-GCM 密文保存（密钥由 PASSWORD_PEPPER 派生，见 src/lib/model-key-vault.ts）；
-- 接口从不返回密钥，只返回尾号 key_hint 供核对。
CREATE TABLE IF NOT EXISTS visitor_model_keys (
  owner_id UUID PRIMARY KEY REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL CHECK (base_url LIKE 'https://%' AND char_length(base_url) BETWEEN 8 AND 300),
  model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 160),
  key_ciphertext BYTEA NOT NULL,
  key_iv BYTEA NOT NULL CHECK (octet_length(key_iv) = 12),
  key_tag BYTEA NOT NULL CHECK (octet_length(key_tag) = 16),
  key_hint TEXT NOT NULL CHECK (char_length(key_hint) BETWEEN 1 AND 8),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('045_visitor_model_keys.sql') ON CONFLICT DO NOTHING;
COMMIT;
