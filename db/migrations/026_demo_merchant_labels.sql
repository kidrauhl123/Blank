BEGIN;

CREATE TEMP TABLE demo_merchant_labels (
  profile_key TEXT NOT NULL,
  reference TEXT PRIMARY KEY,
  merchant_name TEXT NOT NULL,
  category TEXT NOT NULL
) ON COMMIT DROP;
INSERT INTO demo_merchant_labels VALUES
  ('potato', 'DEMO-potato-0', '上海栖云软件有限公司', '工资'),
  ('potato', 'DEMO-potato-1', '漫拿咖啡', '餐饮'),
  ('potato', 'DEMO-potato-2', '禾马鲜生', '购物'),
  ('potato', 'DEMO-potato-3', '申城轨道交通', '交通'),
  ('potato', 'DEMO-potato-4', '老乡饭馆', '餐饮'),
  ('potato', 'DEMO-potato-5', '佰度网盘', '订阅'),
  ('potato', 'DEMO-potato-6', '秋秋音乐', '订阅'),
  ('potato', 'DEMO-potato-7', '申城电力', '生活缴费'),
  ('potato', 'DEMO-potato-8', '京冬图书', '教育'),
  ('potato', 'DEMO-potato-9', '嘀嘀出行', '交通'),
  ('potato', 'DEMO-potato-10', '禾马鲜生', '购物'),
  ('potato', 'DEMO-potato-11', '西北莜面村', '餐饮'),
  ('potato', 'DEMO-potato-12', '上海栖云软件有限公司', '工资'),
  ('potato', 'DEMO-potato-13', '上海澄光数码商行', '购物'),
  ('potato', 'DEMO-potato-OPENING', '云川银行 · 本人账户转入', '入金'),
  ('potato', 'DEMO-INV-potato-CAPITAL', '云川银行 · 本人账户转入', '入金'),
  ('chestnut', 'DEMO-chestnut-0', '陈建国', '收入'),
  ('chestnut', 'DEMO-chestnut-1', '瑞星咖啡', '餐饮'),
  ('chestnut', 'DEMO-chestnut-2', '永惠超市', '购物'),
  ('chestnut', 'DEMO-chestnut-3', '杭城轨道交通', '交通'),
  ('chestnut', 'DEMO-chestnut-4', '麦香堡', '餐饮'),
  ('chestnut', 'DEMO-chestnut-5', '佰度网盘', '订阅'),
  ('chestnut', 'DEMO-chestnut-6', '云易音乐', '订阅'),
  ('chestnut', 'DEMO-chestnut-7', '杭城电力', '生活缴费'),
  ('chestnut', 'DEMO-chestnut-8', '叮当网', '教育'),
  ('chestnut', 'DEMO-chestnut-9', '嘀嘀出行', '交通'),
  ('chestnut', 'DEMO-chestnut-10', '永惠超市', '购物'),
  ('chestnut', 'DEMO-chestnut-11', '必胜坊', '餐饮'),
  ('chestnut', 'DEMO-chestnut-12', '陈建国', '收入'),
  ('chestnut', 'DEMO-chestnut-13', '杭州青禾数码商行', '购物'),
  ('chestnut', 'DEMO-chestnut-OPENING', '青禾银行 · 本人账户转入', '入金'),
  ('chestnut', 'DEMO-INV-chestnut-CAPITAL', '青禾银行 · 本人账户转入', '入金'),
  ('apple', 'DEMO-apple-0', '微付商户结算', '经营收入'),
  ('apple', 'DEMO-apple-1', '星杯咖啡', '餐饮'),
  ('apple', 'DEMO-apple-2', '山木会员商店', '购物'),
  ('apple', 'DEMO-apple-3', '苏城轨道交通', '交通'),
  ('apple', 'DEMO-apple-4', '和风捞面', '餐饮'),
  ('apple', 'DEMO-apple-5', '佰度网盘', '订阅'),
  ('apple', 'DEMO-apple-6', '秋秋音乐', '订阅'),
  ('apple', 'DEMO-apple-7', '苏城电力', '生活缴费'),
  ('apple', 'DEMO-apple-8', '京冬图书', '教育'),
  ('apple', 'DEMO-apple-9', '曹小曹出行', '交通'),
  ('apple', 'DEMO-apple-10', '大润佳超市', '购物'),
  ('apple', 'DEMO-apple-11', '老灶娘舅', '餐饮'),
  ('apple', 'DEMO-apple-12', '微付商户结算', '经营收入'),
  ('apple', 'DEMO-apple-13', '苏州云帆办公设备有限公司', '购物'),
  ('apple', 'DEMO-apple-OPENING', '澄江银行 · 本人账户转入', '入金'),
  ('apple', 'DEMO-INV-apple-CAPITAL', '澄江银行 · 本人账户转入', '入金'),
  ('watermelon', 'DEMO-watermelon-0', '成都云栖设计有限公司', '工资'),
  ('watermelon', 'DEMO-watermelon-1', '西索咖啡', '餐饮'),
  ('watermelon', 'DEMO-watermelon-2', '伊禾生活馆', '购物'),
  ('watermelon', 'DEMO-watermelon-3', '蓉城轨道交通', '交通'),
  ('watermelon', 'DEMO-watermelon-4', '乡里小厨', '餐饮'),
  ('watermelon', 'DEMO-watermelon-5', '佰度网盘', '订阅'),
  ('watermelon', 'DEMO-watermelon-6', '云易音乐', '订阅'),
  ('watermelon', 'DEMO-watermelon-7', '蓉城电力', '生活缴费'),
  ('watermelon', 'DEMO-watermelon-8', '西西里书店', '教育'),
  ('watermelon', 'DEMO-watermelon-9', '嘀嘀出行', '交通'),
  ('watermelon', 'DEMO-watermelon-10', '禾马鲜生', '购物'),
  ('watermelon', 'DEMO-watermelon-11', '肯麦基', '餐饮'),
  ('watermelon', 'DEMO-watermelon-12', '成都云栖设计有限公司', '工资'),
  ('watermelon', 'DEMO-watermelon-13', '成都拾光摄影器材商行', '购物'),
  ('watermelon', 'DEMO-watermelon-OPENING', '锦川银行 · 本人账户转入', '入金'),
  ('watermelon', 'DEMO-INV-watermelon-CAPITAL', '锦川银行 · 本人账户转入', '入金'),
  ('orange', 'DEMO-orange-0', '深圳远舟科技有限公司', '工资'),
  ('orange', 'DEMO-orange-1', '星杯咖啡', '餐饮'),
  ('orange', 'DEMO-orange-2', '沃佳超市', '购物'),
  ('orange', 'DEMO-orange-3', '鹏城轨道交通', '交通'),
  ('orange', 'DEMO-orange-4', '真味蒸食', '餐饮'),
  ('orange', 'DEMO-orange-5', '佰度网盘', '订阅'),
  ('orange', 'DEMO-orange-6', '秋秋音乐', '订阅'),
  ('orange', 'DEMO-orange-7', '鹏城电力', '生活缴费'),
  ('orange', 'DEMO-orange-8', '鹏城书城', '教育'),
  ('orange', 'DEMO-orange-9', '嘀嘀出行', '交通'),
  ('orange', 'DEMO-orange-10', '山木会员商店', '购物'),
  ('orange', 'DEMO-orange-11', '太一酸菜鱼', '餐饮'),
  ('orange', 'DEMO-orange-12', '深圳远舟科技有限公司', '工资'),
  ('orange', 'DEMO-orange-13', 'NORTHLINE DIGITAL HK', '购物'),
  ('orange', 'DEMO-orange-OPENING', '南湾银行 · 本人账户转入', '入金'),
  ('orange', 'DEMO-INV-orange-CAPITAL', '南湾银行 · 本人账户转入', '入金');

UPDATE bank_transactions b
SET merchant_name=m.merchant_name, category=m.category
FROM demo_merchant_labels m, accounts a, demo_profiles p
WHERE b.account_id=a.id AND a.customer_id=p.customer_id
  AND p.profile_key=m.profile_key
  AND b.metadata->>'source'='DEMO_SEED'
  AND b.metadata->>'ledgerReference'=m.reference;

UPDATE ledger_transactions l
SET description=b.merchant_name
FROM bank_transactions b, demo_merchant_labels m, accounts a, demo_profiles p
WHERE l.reference=m.reference AND b.metadata->>'ledgerReference'=l.reference
  AND b.metadata->>'source'='DEMO_SEED'
  AND b.account_id=a.id AND a.customer_id=p.customer_id AND p.profile_key=m.profile_key;

CREATE TEMP TABLE demo_subscription_labels (
  profile_key TEXT NOT NULL,
  old_name TEXT NOT NULL,
  merchant_name TEXT NOT NULL
) ON COMMIT DROP;
INSERT INTO demo_subscription_labels VALUES
  ('potato', '云盘会员', '佰度网盘'),
  ('potato', '音乐会员', '秋秋音乐'),
  ('chestnut', '云盘会员', '佰度网盘'),
  ('chestnut', '音乐会员', '云易音乐'),
  ('apple', '云盘会员', '佰度网盘'),
  ('apple', '音乐会员', '秋秋音乐'),
  ('watermelon', '云盘会员', '佰度网盘'),
  ('watermelon', '音乐会员', '云易音乐'),
  ('orange', '云盘会员', '佰度网盘'),
  ('orange', '音乐会员', '秋秋音乐');

UPDATE subscriptions s
SET merchant_name=m.merchant_name
FROM demo_subscription_labels m, demo_profiles p
WHERE s.customer_id=p.customer_id AND p.profile_key=m.profile_key
  AND s.merchant_name IN (m.old_name, m.old_name || '（模拟）');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM demo_merchant_labels m
    JOIN demo_profiles p ON p.profile_key=m.profile_key
    JOIN accounts a ON a.customer_id=p.customer_id
    JOIN bank_transactions b ON b.account_id=a.id
      AND b.metadata->>'ledgerReference'=m.reference AND b.metadata->>'source'='DEMO_SEED'
    LEFT JOIN ledger_transactions l ON l.reference=m.reference
    WHERE b.merchant_name<>m.merchant_name OR b.category<>m.category
      OR l.description IS DISTINCT FROM m.merchant_name
  ) THEN
    RAISE EXCEPTION 'Merchant labels and ledger descriptions do not match';
  END IF;
END;
$$;

INSERT INTO schema_migrations(version) VALUES('026_demo_merchant_labels.sql') ON CONFLICT DO NOTHING;
COMMIT;
