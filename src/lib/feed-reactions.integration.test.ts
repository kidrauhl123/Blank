import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { setFeedReaction, tasteFor } from "./feed-store";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("动态的赞和踩（真实数据库）", () => {
  const customer = randomUUID(), other = randomUUID();
  const posts = [randomUUID(), randomUUID()];
  const stranger = randomUUID();
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Reaction test',$2),($3,'Reaction other',$4)", [customer, randomUUID(), other, randomUUID()]);
    await query(`INSERT INTO feed_posts(id,customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,visitor_owner_id) VALUES
      ($1,$3,'reaction-test-1','spending-calendar','咖啡日历','本周 4 笔','测试',false,'{"type":"recipe","blocks":[]}'::jsonb,'{}',NULL),
      ($2,$3,'reaction-test-2','position','理财走势','本月 1 次','测试',false,'{"type":"recipe","blocks":[]}'::jsonb,'{}',NULL)`,
    [posts[0], posts[1], customer]);
    await query(`INSERT INTO feed_posts(id,customer_id,dedupe_key,kind,title,body,source,attention,chart,fact_ids,visitor_owner_id) VALUES
      ($1,$2,'reaction-test-3','position','别人的动态','无','测试',false,'{"type":"recipe","blocks":[]}'::jsonb,'{}',NULL)`,
    [stranger, other]);
  });
  afterAll(async () => {
    await query("DELETE FROM feed_reactions WHERE customer_id=ANY($1::uuid[])", [[customer, other]]);
    await query("DELETE FROM feed_posts WHERE customer_id=ANY($1::uuid[])", [[customer, other]]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [[customer, other]]);
    await db.end();
  });

  it("点赞、点踩、改主意、取消都记在服务端，口味分按类汇总", async () => {
    expect(await setFeedReaction(customer, "owner-a", posts[0], "up")).toBe(true);
    expect(await setFeedReaction(customer, "owner-a", posts[1], "down")).toBe(true);
    expect(await tasteFor(customer, "owner-a")).toEqual({ "spending-calendar": 1, position: -1 });
    await setFeedReaction(customer, "owner-a", posts[0], "down");
    expect(await tasteFor(customer, "owner-a")).toEqual({ "spending-calendar": -1, position: -1 });
    await setFeedReaction(customer, "owner-a", posts[0], null);
    expect(await tasteFor(customer, "owner-a")).toEqual({ position: -1 });
  });

  it("别的访客的态度不影响这位访客；不指定访客时汇总这位客户所有访客", async () => {
    await setFeedReaction(customer, "owner-b", posts[0], "up");
    expect(await tasteFor(customer, "owner-a")).toEqual({ position: -1 });
    expect(await tasteFor(customer, "owner-b")).toEqual({ "spending-calendar": 1 });
    expect(await tasteFor(customer, null)).toEqual({ position: -1, "spending-calendar": 1 });
  });

  it("只能对自己客户的动态表态，别人的动态找不到", async () => {
    expect(await setFeedReaction(other, "owner-x", posts[0], "up")).toBe(false);
    expect(await tasteFor(other, null)).toEqual({});
    expect(await setFeedReaction(customer, "owner-a", stranger, "up")).toBe(false);
  });
});
