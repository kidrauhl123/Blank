BEGIN;

-- Display text only; retain amounts, dates, receipts and provenance flags.
CREATE FUNCTION pg_temp.bankpilot_business_label(label TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(
    label, '（模拟）', ''), '模拟历史申购', '申购'), '模拟历史赎回', '赎回'),
    '模拟理财期初资金', '理财期初资金'), '模拟期初资金', '期初资金'),
    '模拟申购', '申购'), '模拟赎回', '赎回'), '模拟理财', '理财');
$$;

UPDATE bank_transactions
SET merchant_name=pg_temp.bankpilot_business_label(merchant_name),
    category=CASE WHEN category='模拟理财' THEN '理财' ELSE category END
WHERE metadata->>'source'='DEMO_SEED' OR metadata->>'simulated'='true';

UPDATE ledger_transactions l
SET description=pg_temp.bankpilot_business_label(l.description)
WHERE EXISTS (
  SELECT 1 FROM bank_transactions b
  WHERE b.metadata->>'ledgerReference'=l.reference
    AND (b.metadata->>'source'='DEMO_SEED' OR b.metadata->>'simulated'='true')
);

UPDATE subscriptions SET merchant_name=pg_temp.bankpilot_business_label(merchant_name)
WHERE customer_id IN (SELECT customer_id FROM demo_profiles)
  AND merchant_name IN ('云盘会员（模拟）','音乐会员（模拟）');

UPDATE investment_products SET issuer='BankPilot'
WHERE is_simulated=true AND issuer='BankPilot 模拟发行';

UPDATE accounts SET name='理财托管'
WHERE system_code='INVESTMENT_CUSTODY' AND name='模拟理财托管';
UPDATE accounts SET name='历史资金清算'
WHERE system_code='DEMO_SEED_CLEARING' AND name='模拟数据对手账户';

UPDATE transfers SET note='朋友间转账'
WHERE operation_id LIKE 'DEMO-TRF-%' AND note='模拟朋友间转账';
UPDATE ledger_transactions SET description='历史转账'
WHERE reference LIKE 'LED-DEMO-TRF-%' AND description='模拟历史转账';

DROP FUNCTION pg_temp.bankpilot_business_label(TEXT);
INSERT INTO schema_migrations(version) VALUES('025_business_display_labels.sql') ON CONFLICT DO NOTHING;
COMMIT;
