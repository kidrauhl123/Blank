BEGIN;

-- Blank 互联（P0-7）：两位客户的 Blank 在双方授权后互发固定格式的消息。只能发授权范围内的内容，不能读对方的账户和流水。
-- 邀请方选择关系和可以分享的内容种类；接受方只能在邀请范围内再选一部分。双方都可以随时撤销。
-- 邀请码只保存哈希，15 分钟内有效，只能用一次。消息没有自由文本：内容都由服务端按发送方自己的数据填好。
CREATE TABLE IF NOT EXISTS blank_link_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE CHECK (char_length(code_hash) = 64),
  from_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('FAMILY', 'FRIEND')),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 3),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blank_invite_used_state CHECK ((used_at IS NULL) = (used_by_customer_id IS NULL))
);
CREATE INDEX IF NOT EXISTS blank_link_invites_owner ON blank_link_invites(from_customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blank_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_a UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  customer_b UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('FAMILY', 'FRIEND')),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT blank_link_distinct CHECK (customer_a <> customer_b),
  CONSTRAINT blank_link_state CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
-- 两个人之间同一时间只能有一条生效的互联。
CREATE UNIQUE INDEX IF NOT EXISTS blank_links_active_pair ON blank_links(LEAST(customer_a, customer_b), GREATEST(customer_a, customer_b)) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS blank_links_customer_a ON blank_links(customer_a, status);
CREATE INDEX IF NOT EXISTS blank_links_customer_b ON blank_links(customer_b, status);

CREATE TABLE IF NOT EXISTS blank_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES blank_links(id) ON DELETE CASCADE,
  from_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  to_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('FRAUD_ALERT', 'SAVINGS_REQUEST', 'REWARD', 'SPLIT_REQUEST')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  dedupe_key TEXT NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blank_message_pair CHECK (from_customer_id <> to_customer_id),
  UNIQUE (from_customer_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS blank_messages_inbox ON blank_messages(to_customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS blank_messages_sender_day ON blank_messages(from_customer_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('044_blank_link.sql') ON CONFLICT DO NOTHING;
COMMIT;
