import { describe, expect, it } from "vitest";
import type { FeedTransaction } from "./feed";
import { evaluateRecipe, recipeDraft, recipePeriodKey, recipeSchema, recipeWindow, type CardRecipe } from "./feed-recipe";

const now = new Date("2026-10-28T04:00:00Z"); // 北京时间周三 12:00
let seq = 0;
const tx = (iso: string, amount: number, merchant: string, category = "餐饮"): FeedTransaction =>
  ({ id: `t${++seq}`, merchant_name: merchant, category, amount_minor: amount, occurred_at: iso, is_anomaly: false });
const coffee: CardRecipe = recipeSchema.parse({
  name: "咖啡周报", headline: "{period}咖啡花了 {total}，{change}",
  query: { direction: "out", merchantKeywords: ["咖啡"], period: "week", groupBy: "day" },
  blocks: [{ type: "stat", value: "count" }, { type: "trend" }, { type: "ranking" }, { type: "compare" }],
  schedule: { every: "week", weekday: 1, hour: 8 },
});
const transactions = [
  tx("2026-10-26T01:00:00Z", -3200, "漫拿咖啡"), tx("2026-10-27T01:00:00Z", -2800, "星杯咖啡"), tx("2026-10-28T01:00:00Z", -3000, "漫拿咖啡"),
  tx("2026-10-27T04:00:00Z", -4500, "老乡饭馆"), // 不是咖啡
  tx("2026-10-20T01:00:00Z", -3000, "漫拿咖啡"), tx("2026-10-21T01:00:00Z", -3000, "瑞星咖啡"), // 上周同期
  tx("2026-10-23T01:00:00Z", -9900, "漫拿咖啡"), // 上周但晚于同期
];

describe("card recipes", () => {
  it("rejects numbers the model writes itself and unknown placeholders", () => {
    const base = { ...coffee, blocks: [{ type: "stat", value: "total" }] };
    expect(recipeSchema.safeParse({ ...base, headline: "这周咖啡花了 300 元" }).success).toBe(false);
    expect(recipeSchema.safeParse({ ...base, headline: "这周咖啡花了 {total}" }).success).toBe(true);
    expect(recipeSchema.safeParse({ ...base, headline: "{balance}" }).success).toBe(false);
    expect(recipeSchema.safeParse({ ...base, blocks: [{ type: "note", text: "少喝 2 杯" }] }).success).toBe(false);
    expect(recipeSchema.safeParse({ ...base, blocks: [{ type: "sql", text: "select" }] }).success).toBe(false);
    expect(recipeSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(recipeSchema.safeParse({ ...base, blocks: Array(5).fill({ type: "trend" }) }).success).toBe(false);
  });

  it("compares this week with the same span last week", () => {
    const window = recipeWindow("week", now);
    expect(window.start.toISOString()).toBe("2026-10-25T16:00:00.000Z"); // 周一 00:00 北京时间
    expect(window.previousEnd.toISOString()).toBe("2026-10-21T04:00:00.000Z");
  });

  it("fills numbers from the ledger only and renders every block", () => {
    const result = evaluateRecipe(coffee, transactions, now);
    expect(result.values).toMatchObject({ total: 9000, count: 3, previous: 6000, change: 50, top: "漫拿咖啡" });
    expect(result.headline).toBe("本周咖啡花了 ¥90，比上周同期多 50%");
    const [stat, trend, ranking, compare] = result.blocks;
    expect(stat).toEqual({ type: "stat", label: "笔数", text: "3 笔" });
    if (trend.type !== "line") throw new Error("trend expected");
    expect(trend.points.map(point => point.minor)).toEqual([3200, 2800, 3000]);
    expect(ranking).toEqual({ type: "bars", items: [{ label: "漫拿咖啡", minor: 6200, note: "2 笔" }, { label: "星杯咖啡", minor: 2800, note: "1 笔" }] });
    expect(compare).toMatchObject({ type: "compare", current: 9000, previous: 6000 });
    expect(result.factIds).toHaveLength(3);
  });

  it("says so when there is nothing to compare", () => {
    const result = evaluateRecipe({ ...coffee, query: { ...coffee.query, merchantKeywords: ["奶茶"] } }, transactions, now);
    expect(result.headline).toBe("本周咖啡花了 ¥0，上期没有记录");
  });

  it("publishes once per period after the chosen time, or right away when saved", () => {
    expect(recipePeriodKey(coffee, now)).toBe("2026-10-26");
    expect(recipePeriodKey({ ...coffee, schedule: { every: "week", weekday: 5, hour: 8 } }, now)).toBeNull();
    expect(recipePeriodKey({ ...coffee, schedule: { every: "week", weekday: 5, hour: 8 } }, now, true)).toBe("2026-10-26");
    expect(recipePeriodKey({ ...coffee, schedule: { every: "day", hour: 20 } }, now)).toBeNull();
    expect(recipePeriodKey({ ...coffee, schedule: { every: "month", day: 1, hour: 8 } }, now)).toBe("2026-10");
  });

  it("holds the post back until the total crosses the threshold", () => {
    expect(recipeDraft("r1", { ...coffee, onlyWhenAbove: 10000 }, transactions, now, "2026-10-26")).toBeNull();
    const draft = recipeDraft("r1", { ...coffee, onlyWhenAbove: 5000 }, transactions, now, "2026-10-26")!;
    expect(draft).toMatchObject({ key: "recipe:r1:2026-10-26", kind: "custom", source: "咖啡周报" });
    expect(draft.body).toContain("合计超过 ¥50 才发");
  });
});
