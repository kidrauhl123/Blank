BEGIN;

-- 新设备登录（P0-3 遗留）：同一位客户第一次从一台新设备登录（而且之前已经有别的设备）时，这次登录的会话标记为新设备；
-- 登录后 24 小时内从这个会话发起的大额转账进入反诈暂缓，走和其他暂缓一样的强验证或 24 小时冷静期。
-- 设备只按“系统 + 浏览器”粗略区分（不存 IP，也不做指纹），浏览器小版本升级不会被当成新设备。演示账户不适用。
CREATE TABLE IF NOT EXISTS customer_devices (
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL CHECK (char_length(device_key) BETWEEN 1 AND 64),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, device_key)
);

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS device_key TEXT CHECK (device_key IS NULL OR char_length(device_key) BETWEEN 1 AND 64);
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS new_device BOOLEAN NOT NULL DEFAULT false;

INSERT INTO schema_migrations(version) VALUES ('042_new_device_guard.sql') ON CONFLICT DO NOTHING;
COMMIT;
