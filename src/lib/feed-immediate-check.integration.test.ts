import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("事件即时触发动态检查（真实数据库）", () => {
  const customer = randomUUID(), account = randomUUID();
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Immediate check test',$2)", [customer, randomUUID()]);
    await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Immediate','CHECKING','TEST')", [account, customer]);
  });
  afterAll(async () => {
    await query("DELETE FROM feed_publisher_state WHERE customer_id=$1", [customer]);
    await query("DELETE FROM bank_transactions WHERE account_id=$1", [account]);
    await query("DELETE FROM accounts WHERE id=$1", [account]);
    await query("DELETE FROM customers WHERE id=$1", [customer]);
    await db.end();
  });

  it("每一笔新入账（存款、退款）或扣款都会标记这位客户需要立即检查，不用等心跳", async () => {
    expect((await query("SELECT 1 FROM feed_publisher_state WHERE customer_id=$1", [customer])).rowCount).toBe(0);
    await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,'存款','收入',500000,now())", [account]);
    const first = await query<{ check_requested_at: Date | null; checked_at: Date }>("SELECT check_requested_at,checked_at FROM feed_publisher_state WHERE customer_id=$1", [customer]);
    expect(first.rows[0].check_requested_at).not.toBeNull();
    expect(first.rows[0].checked_at.getTime()).toBe(0);
    await query("UPDATE feed_publisher_state SET check_requested_at=NULL, checked_at=now() WHERE customer_id=$1", [customer]);
    await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,'订阅扣费','订阅',-1900,now())", [account]);
    const second = await query<{ check_requested_at: Date | null }>("SELECT check_requested_at FROM feed_publisher_state WHERE customer_id=$1", [customer]);
    expect(second.rows[0].check_requested_at).not.toBeNull();
  });
});
