import { describe, expect, it } from "vitest";
import { budgetBaseline, explainSpendingChange, shiftMonth, type SpendingRow } from "./spending-analysis";

const row = (month: string, category: string, merchant: string, count: number, totalMinor: number, direction: "OUT" | "IN" = "OUT"): SpendingRow =>
  ({ month, category, merchant, count, totalMinor, direction });

// 本月 2026-10；前三个月为 2026-07 至 2026-09。
const rows: SpendingRow[] = [
  row("2026-08", "餐饮", "聚餐店", 1, 2000),
  row("2026-09", "餐饮", "漫拿咖啡", 2, 1600),
  row("2026-09", "餐饮", "老乡饭馆", 2, 3000),
  row("2026-10", "餐饮", "漫拿咖啡", 5, 4000),
  row("2026-10", "餐饮", "聚餐店", 3, 9000),
  row("2026-10", "餐饮", "老乡饭馆", 2, 3000),
  row("2026-10", "信用卡", "信用卡年费", 1, 30000),
  row("2026-10", "购物", "新商城", 1, 5000),
  row("2026-10", "工资", "某公司", 1, 800000, "IN"),
];
const largest = [{ merchant: "信用卡年费", category: "信用卡", amountMinor: 30000, occurredAt: "2026-10-03T02:00:00.000Z" }];

describe("消费变化的原因", () => {
  it("汇总本月与上月的支出，收入不计入", () => {
    const result = explainSpendingChange(rows, "2026-10", largest);
    expect(result).toMatchObject({ month: "2026-10", previousMonth: "2026-09",
      spendingMinor: { current: 51000, previous: 4600, deltaMinor: 46400 }, transactionCount: { current: 12, previous: 4 } });
  });

  it("分类按变化幅度排序，并给出笔数变化", () => {
    const result = explainSpendingChange(rows, "2026-10", largest);
    expect(result.categories[0]).toMatchObject({ category: "信用卡", deltaMinor: 30000, deltaCount: 1 });
    expect(result.categories[1]).toMatchObject({ category: "餐饮", currentMinor: 16000, previousMinor: 4600, deltaMinor: 11400, deltaCount: 6 });
  });

  it("找出重复光顾的商户、新商户和费用类支出，新商户要排除前几个月出现过的", () => {
    const result = explainSpendingChange(rows, "2026-10", largest);
    expect(result.repeatedMerchants.map(item => [item.merchant, item.count])).toEqual([["漫拿咖啡", 5], ["聚餐店", 3]]);
    expect(result.newMerchants.map(item => item.merchant)).toEqual(["信用卡年费", "新商城"]);
    expect(result.feeItems.map(item => item.merchant)).toEqual(["信用卡年费"]);
    expect(result.largestItems).toEqual(largest);
  });
});

describe("预算基线", () => {
  it("用近 3 个完整月的平均值给出分类上限建议，向上取整到 50 元", () => {
    const result = budgetBaseline(rows, "2026-10");
    expect(result.baselineMonths).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(result.monthsWithData).toBe(2);
    expect(result.spendingAverageMinor).toBe(2200);
    expect(result.incomeAverageMinor).toBe(0);
    expect(result.monthToDateMinor).toBe(51000);
    expect(result.categories).toEqual([{ category: "餐饮", averageMinor: 2200, suggestedCapMinor: 5000, monthToDateMinor: 16000, usedPercent: 320 }]);
  });

  it("没有历史数据时返回空分类，而不是零上限", () => {
    expect(budgetBaseline([row("2026-10", "餐饮", "漫拿咖啡", 1, 3200)], "2026-10")).toMatchObject({ monthsWithData: 0, categories: [] });
  });
});

describe("月份计算", () => {
  it("按自然月加减，跨年正确", () => {
    expect(shiftMonth("2026-10", -3)).toBe("2026-07");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});
