import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { ensureDemoProfiles } from "./demo";
import { ensureDemoInvestmentHistory } from "./demo-investments";
import { advanceShowcaseLife, resetShowcaseLife } from "./demo-life";
import { listFeed } from "./feed-store";
import { removeDemoSeed } from "./demo-test-seed";

// 银行不变量检查（db/invariants.sql 中的 DO 块），不依赖 psql。去掉"客户必须有凭据"这一条：
// 它检查的是全库状态，其他集成测试的临时客户可能正好还在，和生活模拟无关。
const invariants = readFileSync("db/invariants.sql", "utf8").match(/DO \$\$[\s\S]*?END \$\$;/)![0]
  .replace(/\n\s*IF EXISTS \(\s*SELECT 1 FROM customers c\s+LEFT JOIN auth_credentials[\s\S]*?END IF;/, "");

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("showcase life simulation", () => {
  let customerId: string;
  const snapshot = () => query<{ id: string; available_balance_minor: string; transactions: string }>(`SELECT a.id,a.available_balance_minor,
    (SELECT count(*) FROM bank_transactions bt WHERE bt.account_id=a.id)::text AS transactions FROM accounts a
    JOIN demo_profiles d ON d.customer_id=a.customer_id ORDER BY a.id`).then(result => result.rows);
  let before: Awaited<ReturnType<typeof snapshot>>;
  let beforeClock: string;
  // 和 demo.integration 一样：如果是本测试种下的演示数据，结束时连同种子一起清掉，后续测试仍拿到未种子的库。
  let ownedSeed = false;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    ownedSeed = !(await query("SELECT 1 FROM demo_profiles")).rowCount;
    await ensureDemoProfiles();
    await ensureDemoInvestmentHistory();
    customerId = (await query<{ customer_id: string }>("SELECT customer_id FROM demo_profiles WHERE profile_key='potato'")).rows[0].customer_id;
    await resetShowcaseLife();
    before = await snapshot();
    beforeClock = (await query<{ day: string }>("SELECT business_date::text AS day FROM investment_simulation_clocks WHERE customer_id=$1", [customerId])).rows[0].day;
    process.env.BANKPILOT_SHOWCASE_LIFE = "1";
  });
  afterAll(async () => {
    delete process.env.BANKPILOT_SHOWCASE_LIFE;
    await resetShowcaseLife();
    if (ownedSeed) await removeDemoSeed();
    await db.end();
  });

  it("stays off unless enabled", async () => {
    delete process.env.BANKPILOT_SHOWCASE_LIFE;
    expect(await advanceShowcaseLife()).toBeNull();
    process.env.BANKPILOT_SHOWCASE_LIFE = "1";
  });

  it("backfills one day per call, then lives in real time, keeping every bank invariant", async () => {
    const now = new Date();
    const steps = [];
    for (let index = 0; index < 40; index++) {
      const step = await advanceShowcaseLife(now);
      if (!step) break;
      steps.push(step);
      if (step.live) break;
    }
    expect(steps.filter(step => !step.live)).toHaveLength(34);
    expect(steps.at(-1)?.live).toBe(true);
    await query(invariants);

    const transactions = await query<{ occurred_at: Date }>(`SELECT bt.occurred_at FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
      WHERE a.customer_id=$1 AND bt.metadata->>'ledgerReference' LIKE '%DEMO-LIFE-%'`, [customerId]);
    expect(transactions.rows.length).toBeGreaterThan(100);
    expect(transactions.rows.every(row => row.occurred_at <= now)).toBe(true);

    // 今天再跑一次不会重复入账。
    const lifeEntries = async () => (await query("SELECT 1 FROM ledger_transactions WHERE transaction_type='DEMO_LIFE'")).rowCount;
    const entries = await lifeEntries();
    await advanceShowcaseLife(now);
    expect(await lifeEntries()).toBe(entries);
  }, 120_000);

  it("publishes a varied feed spread over the simulated weeks", async () => {
    const posts = await listFeed(customerId);
    const kinds = new Set(posts.map(post => post.kind));
    for (const kind of ["anomaly", "subscription-due", "spending-calendar", "money-flow", "friends", "position", "subscriptions"]) expect(kinds).toContain(kind);
    const days = new Set(posts.map(post => post.publishedAt.slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(10);
    expect(posts.every(post => Date.parse(post.publishedAt) <= Date.now())).toBe(true);
  });

  it("resets to exactly the seeded accounts", async () => {
    expect(await resetShowcaseLife()).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect((await query<{ day: string }>("SELECT business_date::text AS day FROM investment_simulation_clocks WHERE customer_id=$1", [customerId])).rows[0].day).toBe(beforeClock);
    expect((await query("SELECT 1 FROM ledger_transactions WHERE transaction_type='DEMO_LIFE'")).rowCount).toBe(0);
    await query(invariants);
  });
});
