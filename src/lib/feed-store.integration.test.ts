import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, query } from "./db";
import { listFeed, requestFeedCheck, runFeedHeartbeat } from "./feed-store";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("feed publishing", () => {
  const customerIds = [randomUUID(), randomUUID()];
  const accountIds = [randomUUID(), randomUUID()];
  const approve = async () => ({ show: true });
  const reject = async () => ({ show: false });
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
    await query("DELETE FROM feed_posts WHERE customer_id=ANY($1::uuid[])", [customerIds]);
    await query("DELETE FROM feed_publisher_state WHERE customer_id=ANY($1::uuid[])", [customerIds]);
    await query("DELETE FROM bank_transactions WHERE account_id=ANY($1::uuid[])", [accountIds]);
    await query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customerIds]);
    await db.end();
  });

  it("does not publish on first read: it only asks for a check, which the scheduler runs through the judge", async () => {
    expect(await listFeed(customerIds[0])).toEqual([]);
    expect((await query("SELECT 1 FROM feed_publisher_state WHERE customer_id=$1 AND check_requested_at IS NOT NULL", [customerIds[0]])).rowCount).toBe(1);
  });

  it("publishes only what the judge approves, keeps the customer's own facts, and never asks again for a key already published", async () => {
    const judge = vi.fn(approve);
    await runFeedHeartbeat({ judge, customerIds: [customerIds[0]] });
    const first = await listFeed(customerIds[0]);
    expect(first.map(post => post.kind)).toEqual(["anomaly", "money-flow"]);
    expect(first[0]).toMatchObject({ title: "这笔 ¥3,999 和你平时不太一样", attention: true });
    expect(first.every(post => !Number.isNaN(Date.parse(post.publishedAt)))).toBe(true);
    expect(JSON.stringify(first)).not.toContain("Other customer");
    expect(judge).toHaveBeenCalled();
    // 再来一次事件：这些帖子都已经发过，不再问模型，列表也不变。
    const asked = judge.mock.calls.length;
    await requestFeedCheck(customerIds[0]);
    await runFeedHeartbeat({ judge, customerIds: [customerIds[0]] });
    expect(judge.mock.calls.length).toBe(asked);
    expect(await listFeed(customerIds[0])).toEqual(first);
  });

  it("when the judge rejects a candidate nothing is published, and the candidate is asked again only at the next check", async () => {
    const judge = vi.fn(reject);
    await runFeedHeartbeat({ judge, customerIds: [customerIds[1]] });
    expect(judge).toHaveBeenCalled();
    expect((await query("SELECT count(*)::int AS count FROM feed_posts WHERE customer_id=$1", [customerIds[1]])).rows[0].count).toBe(0);
    // 心跳还没到期：不再问。
    const asked = judge.mock.calls.length;
    await runFeedHeartbeat({ judge, customerIds: [customerIds[1]] });
    expect(judge.mock.calls.length).toBe(asked);
    // 下一次事件打的标记：候选还在，会再问一次（被拒绝的不会因为“检查过了”就丢掉）。
    await requestFeedCheck(customerIds[1]);
    await runFeedHeartbeat({ judge, customerIds: [customerIds[1]] });
    expect(judge.mock.calls.length).toBeGreaterThan(asked);
  });

  it("checks each customer at most once an hour unless an event asks for it", async () => {
    const judge = vi.fn(approve);
    const before = await query<{ checked_at: Date }>("SELECT checked_at FROM feed_publisher_state WHERE customer_id=$1", [customerIds[0]]);
    await runFeedHeartbeat({ judge, customerIds: [customerIds[0]] });
    const after = await query<{ checked_at: Date }>("SELECT checked_at FROM feed_publisher_state WHERE customer_id=$1", [customerIds[0]]);
    expect(after.rows[0].checked_at).toEqual(before.rows[0].checked_at);
    expect(judge).not.toHaveBeenCalled();
  });
});
