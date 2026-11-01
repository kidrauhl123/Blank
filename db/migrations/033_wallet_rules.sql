BEGIN;

-- Agent 钱包与规矩。演示账户由访客共用，所以钱包和规矩都按访客隔离：每位访客有自己的钱包子账户。
-- 钱包是付款人名下的子账户（customer_id = 付款人）：现有的转出校验 source.customer_id === customerId 因此仍然成立；
-- 免确认的钱只从这里出，损失有硬上限。
-- 钱包按（访客, 客户）各一个：同一访客切换到另一位客户时，钱不能被记到前一位客户名下。
CREATE TABLE IF NOT EXISTS wallet_accounts (
  owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, customer_id)
);

-- 规矩只有固定模板，参数由服务端按硬上限校验；是否在规矩内由 wallet-core 的确定性代码判断，模型无权决定。
-- DRAFT：模型提议后等用户本人强验证；COOLING：已验证，24 小时冷静期后才生效（effective_at，“生效”不是状态）；
-- PAUSED：异常时自动暂停；REVOKED：用户撤销；DISMISSED：用户点了“不要”。
CREATE TABLE IF NOT EXISTS wallet_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id),
  template TEXT NOT NULL CHECK (template IN ('pay_trusted_small')),
  params JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'COOLING', 'PAUSED', 'REVOKED', 'DISMISSED')),
  authorized_by TEXT CHECK (authorized_by IN ('PASSKEY', 'TOTP')),
  authorized_at TIMESTAMPTZ,
  effective_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  paused_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_rules_owner ON wallet_rules(customer_id, owner_id, created_at DESC);

-- 规矩内的转账就是 transfers 里 rule_id 不为空的行（转账流程写入），所以不再需要单独的付款表。
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS rule_id UUID REFERENCES wallet_rules(id);
CREATE INDEX IF NOT EXISTS transfers_rule ON transfers(rule_id) WHERE rule_id IS NOT NULL;

-- Passkey（WebAuthn）：创建和修改规矩的强验证。凭据属于访客，私钥永远留在用户的设备里。
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS passkey_credentials_owner ON passkey_credentials(owner_id);

CREATE TABLE IF NOT EXISTS passkey_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES visitor_memory_owners(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS passkey_challenges_owner ON passkey_challenges(owner_id, purpose);

-- 每个助手任务记下用户本人在 App 里亲手输入的开场白和来源（键入 / 语音）：立规矩和免确认付款只认它，
-- 页面内容、备注、商户名、工具返回里的“指令”不算；语音转写也不算。任务中途恢复时从这里读回。
ALTER TABLE app_agent_runs ADD COLUMN IF NOT EXISTS start_text TEXT;
ALTER TABLE app_agent_runs ADD COLUMN IF NOT EXISTS start_source TEXT CHECK (start_source IN ('typed', 'voice'));

INSERT INTO schema_migrations(version) VALUES ('033_wallet_rules.sql') ON CONFLICT DO NOTHING;
COMMIT;
