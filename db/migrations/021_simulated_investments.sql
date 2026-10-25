BEGIN;

ALTER TABLE investment_products ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE investment_products ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS investment_simulation_clocks (
  customer_id UUID PRIMARY KEY REFERENCES customers(id),
  business_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')::date,
  version INTEGER NOT NULL DEFAULT 0,
  CHECK (business_date BETWEEN '2026-01-01' AND '2045-12-31')
);

CREATE TABLE IF NOT EXISTS investment_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  product_id UUID NOT NULL REFERENCES investment_products(id),
  quantity_micro BIGINT NOT NULL CHECK (quantity_micro > 0),
  cost_minor BIGINT NOT NULL CHECK (cost_minor > 0),
  purchased_on DATE NOT NULL,
  unlocks_on DATE NOT NULL,
  terms JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REDEEMED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investment_positions_customer ON investment_positions(customer_id,status);

ALTER TABLE investment_orders ADD COLUMN IF NOT EXISTS idempotency_key UUID;
ALTER TABLE investment_orders ADD COLUMN IF NOT EXISTS position_id UUID REFERENCES investment_positions(id);
ALTER TABLE investment_orders ADD COLUMN IF NOT EXISTS quote JSONB;
ALTER TABLE investment_orders ADD COLUMN IF NOT EXISTS authorization_fingerprint TEXT;
ALTER TABLE investment_orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE investment_orders ADD COLUMN IF NOT EXISTS receipt JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS idx_investment_orders_request ON investment_orders(customer_id,idempotency_key);

-- All terms and price paths belong to the competition sandbox, not a live issuer.
INSERT INTO investment_products
  (id,external_code,name,issuer,product_type,risk_level,minimum_purchase_minor,term_days,status,
   source_url,source_checked_at,is_simulated,facts)
VALUES
  ('02100000-0000-4000-8000-000000000001','SIM-F01','零钱灵活','BankPilot 模拟发行','FLEXIBLE','R1',10000,0,'OPEN',
   'bankpilot:simulation:wealth-v1',now(),true,'{"kind":"FLEXIBLE","holdingDays":0,"purchaseFeeBps":0,"redemptionFeeBps":0,"driftBps":180,"volatilityBps":2,"seed":101,"epoch":"2026-01-01","modelVersion":"wealth-v1"}'),
  ('02100000-0000-4000-8000-000000000002','SIM-F02','日享灵活','BankPilot 模拟发行','FLEXIBLE','R2',100000,0,'OPEN',
   'bankpilot:simulation:wealth-v1',now(),true,'{"kind":"FLEXIBLE","holdingDays":0,"purchaseFeeBps":0,"redemptionFeeBps":5,"driftBps":240,"volatilityBps":8,"seed":207,"epoch":"2026-01-01","modelVersion":"wealth-v1"}'),
  ('02100000-0000-4000-8000-000000000003','SIM-H30','稳享 30 天','BankPilot 模拟发行','HOLDING','R2',100000,30,'OPEN',
   'bankpilot:simulation:wealth-v1',now(),true,'{"kind":"HOLDING","holdingDays":30,"purchaseFeeBps":0,"redemptionFeeBps":5,"driftBps":280,"volatilityBps":10,"seed":313,"epoch":"2026-01-01","modelVersion":"wealth-v1"}'),
  ('02100000-0000-4000-8000-000000000004','SIM-H60','均衡 60 天','BankPilot 模拟发行','HOLDING','R3',500000,60,'OPEN',
   'bankpilot:simulation:wealth-v1',now(),true,'{"kind":"HOLDING","holdingDays":60,"purchaseFeeBps":10,"redemptionFeeBps":10,"driftBps":350,"volatilityBps":35,"seed":419,"epoch":"2026-01-01","modelVersion":"wealth-v1"}'),
  ('02100000-0000-4000-8000-000000000005','SIM-C90','定享 90 天','BankPilot 模拟发行','CLOSED','R2',100000,90,'OPEN',
   'bankpilot:simulation:wealth-v1',now(),true,'{"kind":"CLOSED","holdingDays":90,"purchaseFeeBps":0,"redemptionFeeBps":0,"driftBps":300,"volatilityBps":12,"seed":523,"epoch":"2026-01-01","modelVersion":"wealth-v1"}'),
  ('02100000-0000-4000-8000-000000000006','SIM-C180','远享 180 天','BankPilot 模拟发行','CLOSED','R3',1000000,180,'OPEN',
   'bankpilot:simulation:wealth-v1',now(),true,'{"kind":"CLOSED","holdingDays":180,"purchaseFeeBps":10,"redemptionFeeBps":0,"driftBps":400,"volatilityBps":40,"seed":631,"epoch":"2026-01-01","modelVersion":"wealth-v1"}')
ON CONFLICT (external_code) DO NOTHING;

INSERT INTO schema_migrations(version) VALUES('021_simulated_investments.sql') ON CONFLICT DO NOTHING;
COMMIT;
