BEGIN;

-- 反诈守护：发起转账时被暂缓的记录。fraud_reasons 是服务端写死的原因（不是模型写的）；
-- hold_until 只在用户选择“24 小时后再办”时才有，期间不能确认，过了这个时间仍然需要强验证。
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS fraud_reasons JSONB;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ;

INSERT INTO schema_migrations(version) VALUES ('035_fraud_guard.sql') ON CONFLICT DO NOTHING;
COMMIT;
