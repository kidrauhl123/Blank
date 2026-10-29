BEGIN;

-- 品牌改名 BankPilot → Blank：只改库里已经保存的展示文案，金额、时间、回执和来源标记保持不变。
UPDATE bank_transactions SET merchant_name=replace(merchant_name,'BankPilot','Blank') WHERE merchant_name LIKE '%BankPilot%';
UPDATE ledger_transactions SET description=replace(description,'BankPilot','Blank') WHERE description LIKE '%BankPilot%';
UPDATE beneficiaries SET bank_name='Blank' WHERE bank_name='BankPilot';
UPDATE investment_products SET issuer='Blank' WHERE issuer='BankPilot';

INSERT INTO schema_migrations(version) VALUES ('030_brand_blank.sql') ON CONFLICT DO NOTHING;
COMMIT;
