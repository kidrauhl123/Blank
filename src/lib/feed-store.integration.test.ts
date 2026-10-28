import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { listFeed, publishDueFeeds, publishFeed } from "./feed-store";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("feed publishing", () => {
  const customerIds = [randomUUID(), randomUUID()];
  const accountIds = [randomUUID(), randomUUID()];
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    for (let index = 0; index < 2; index++) {
      await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Feed test',$2)", [customerIds[index], randomUUID()]);
      await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Test','CHECKING','TEST')", [accountIds[index], customerIds[index]]);
    }
    await query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at,is_anomaly) VALUES
      ($1,'咖啡','餐饮',-3200,now() - interval '1 day',false),
      ($1,'澄光数码','购物',-399900,now() - interval '2 days',true),
      ($2,'Other customer','餐饮',-500000,now() - interval '1 day',true)`, accountIds);
  });
  afterAll(async () => {
    await query("DELETE FROM bank_transactions WHERE account_id=ANY($1::uuid[])", [accountIds]);
    await query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customerIds]);
    await db.end();
  });

  it("publishes on first read, keeps the customer's own facts, and never republishes the same key", async () => {
    const first = await listFeed(customerIds[0]);
    expect(first.map(post => post.kind)).toEqual(["anomaly", "money-flow"]);
    expect(first[0]).toMatchObject({ title: "这笔 ¥3,999 和你平时不太一样", attention: true });
    expect(first.every(post => !Number.isNaN(Date.parse(post.publishedAt)))).toBe(true);
    expect(JSON.stringify(first)).not.toContain("Other customer");
    expect(await publishFeed(customerIds[0])).toBe(0);
    expect(await listFeed(customerIds[0])).toEqual(first);
  });

  it("lets the scheduler check each customer at most once per interval", async () => {
    await publishDueFeeds(100);
    const checked = await query<{ checked_at: Date }>("SELECT checked_at FROM feed_publisher_state WHERE customer_id=$1", [customerIds[1]]);
    expect(checked.rows).toHaveLength(1);
    await publishDueFeeds(100);
    const again = await query<{ checked_at: Date }>("SELECT checked_at FROM feed_publisher_state WHERE customer_id=$1", [customerIds[1]]);
    expect(again.rows[0].checked_at).toEqual(checked.rows[0].checked_at);
  });
});
