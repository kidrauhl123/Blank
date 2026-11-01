import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "./db";
import { cardAction } from "./card-action";
import { budgetBaselineFor, explainSpending } from "./spending-analysis";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("消费分析与卡片检查（真实数据库）", () => {
  const customerIds = [randomUUID(), randomUUID()];
  const accountIds = [randomUUID(), randomUUID()];
  const cardIds = [randomUUID(), randomUUID()];
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    for (let index = 0; index < 2; index++) {
      await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Spending test',$2)", [customerIds[index], randomUUID()]);
      await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Test','CHECKING','TEST')", [accountIds[index], customerIds[index]]);
    }
    await query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES
      ($1,'聚餐店','餐饮',-2000,'2026-08-10T04:00:00Z'),
      ($1,'漫拿咖啡','餐饮',-1600,'2026-09-10T04:00:00Z'),
      ($1,'老乡饭馆','餐饮',-3000,'2026-09-12T04:00:00Z'),
      ($1,'漫拿咖啡','餐饮',-4000,'2026-10-02T04:00:00Z'),
      ($1,'聚餐店','餐饮',-9000,'2026-10-03T04:00:00Z'),
      ($1,'信用卡年费','信用卡',-30000,'2026-10-04T04:00:00Z'),
      ($1,'朋友','转账',-500000,'2026-10-05T04:00:00Z'),
      ($1,'基金申购','理财',-200000,'2026-10-05T04:00:00Z'),
      ($1,'某公司','工资',800000,'2026-10-01T02:00:00Z')`, [accountIds[0]]);
    await query(`INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES
      ($1,'别人的店','餐饮',-99900,'2026-10-03T04:00:00Z')`, [accountIds[1]]);
    await query("INSERT INTO cards(id,customer_id,account_id,card_name,masked_no,card_type,status) VALUES($1,$2,$3,'日常卡','6222 **** 1234','VIRTUAL','ACTIVE')", [cardIds[0], customerIds[0], accountIds[0]]);
    await query("INSERT INTO cards(id,customer_id,account_id,card_name,masked_no,card_type,status) VALUES($1,$2,$3,'旅行卡','6222 **** 5678','VIRTUAL','LOCKED')", [cardIds[1], customerIds[0], accountIds[0]]);
  });
  afterAll(async () => {
    // Only fixture IDs are removed; this suite never truncates tables.
    await query("DELETE FROM cards WHERE id=ANY($1::uuid[])", [cardIds]);
    await query("DELETE FROM bank_transactions WHERE account_id=ANY($1::uuid[])", [accountIds]);
    await query("DELETE FROM accounts WHERE id=ANY($1::uuid[])", [accountIds]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customerIds]);
    await db.end();
  });

  it("只看支出：转账和理财不计入，收入不计入，另一位客户的流水不混入", async () => {
    const result = await explainSpending(customerIds[0], "2026-10");
    expect(result.spendingMinor).toEqual({ current: 43000, previous: 4600, deltaMinor: 38400 });
    expect(result.transactionCount).toEqual({ current: 3, previous: 2 });
    expect(result.categories[0]).toMatchObject({ category: "信用卡", deltaMinor: 30000 });
    expect(result.newMerchants.map(item => item.merchant)).toEqual(["信用卡年费"]);
    expect(result.feeItems.map(item => item.merchant)).toEqual(["信用卡年费"]);
    expect(result.largestItems.map(item => item.amountMinor)).toEqual([30000, 9000, 4000]);
    expect(await explainSpending(customerIds[1], "2026-10")).toMatchObject({ spendingMinor: { current: 99900 } });
  });

  it("预算基线用近 3 个完整月的餐饮平均值，本月已花按 Beijing 自然月计", async () => {
    const result = await budgetBaselineFor(customerIds[0], "2026-10");
    expect(result).toMatchObject({ monthsWithData: 2, spendingAverageMinor: 2200, incomeAverageMinor: 0, monthToDateMinor: 43000 });
    expect(result.categories).toEqual([{ category: "餐饮", averageMinor: 2200, suggestedCapMinor: 5000, monthToDateMinor: 13000, usedPercent: 260 }]);
  });

  it("没有数据的月份返回真实的零，非法月份被拒绝", async () => {
    expect(await explainSpending(customerIds[0], "2025-01")).toMatchObject({ spendingMinor: { current: 0, previous: 0 }, categories: [], largestItems: [] });
    await expect(explainSpending(customerIds[0], "2026-13")).rejects.toThrow("INVALID_STATEMENT_MONTH");
    await expect(budgetBaselineFor(customerIds[0], "2026-00")).rejects.toThrow("INVALID_STATEMENT_MONTH");
  });

  it("卡片检查只看当前客户的卡：锁定唯一的正常卡；没有卡的客户如实说明", async () => {
    expect(await cardAction(customerIds[0], { action: "lock", last4: "1234" })).toMatchObject({ status: "READY", card: { name: "日常卡", last4: "1234", status: "正常" } });
    expect(await cardAction(customerIds[0], { action: "lock", last4: "5678" })).toMatchObject({ status: "ALREADY_LOCKED" });
    expect(await cardAction(customerIds[1], { action: "lock" })).toMatchObject({ error: expect.stringContaining("没有卡片") });
  });
});
