BEGIN;

-- 事件即时触发（P0-4 遗留）：每一笔新的入账、扣款、转出都会在同一个事务里给这位客户打上“需要检查动态”的标记，
-- 下一次调度（约 15 秒）就会检查，不再只等每小时的心跳。这里只写标记，不调用模型；是否发帖仍由 Jev 决定。
CREATE OR REPLACE FUNCTION request_feed_check_for_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO feed_publisher_state(customer_id, checked_at, check_requested_at)
  SELECT a.customer_id, 'epoch'::timestamptz, now() FROM accounts a
  WHERE a.id = NEW.account_id AND a.customer_id IS NOT NULL
  ON CONFLICT (customer_id) DO UPDATE SET check_requested_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bank_transactions_feed_check ON bank_transactions;
CREATE TRIGGER bank_transactions_feed_check AFTER INSERT ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION request_feed_check_for_transaction();

INSERT INTO schema_migrations(version) VALUES ('041_feed_immediate_checks.sql') ON CONFLICT DO NOTHING;
COMMIT;
