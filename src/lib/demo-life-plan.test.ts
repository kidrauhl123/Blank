import { describe, expect, it } from "vitest";
import { epochDay, planLifeDay } from "./demo-life-plan";

const days = (from: string, count: number) => Array.from({ length: count }, (_, index) =>
  new Date(new Date(`${from}T12:00:00Z`).getTime() + index * 86_400_000).toISOString().slice(0, 10));

describe("showcase life plan", () => {
  it("is deterministic and sorted by time", () => {
    expect(planLifeDay("2026-10-28")).toEqual(planLifeDay("2026-10-28"));
    const times = planLifeDay("2026-10-28").map(event => event.time);
    expect(times).toEqual([...times].sort());
  });

  it("follows the month: rent on the 1st, salary on the 10th, side income on the 25th", () => {
    expect(planLifeDay("2026-11-01").find(event => event.slot === "rent")).toMatchObject({ amountMinor: -450000, category: "住房" });
    expect(planLifeDay("2026-11-10").find(event => event.slot === "salary")).toMatchObject({ amountMinor: 1250000, kind: "income" });
    expect(planLifeDay("2026-11-25").find(event => event.slot === "side-income")).toMatchObject({ amountMinor: 200000 });
  });

  it("invests every Monday and commutes only on workdays", () => {
    expect(planLifeDay("2026-10-26").some(event => event.kind === "invest" && event.productCode === "SIM-H30")).toBe(true); // 周一
    expect(planLifeDay("2026-10-27").some(event => event.kind === "invest")).toBe(false);
    expect(planLifeDay("2026-10-31").some(event => event.slot === "metro")).toBe(false); // 周六
    expect(planLifeDay("2026-10-31").some(event => event.slot === "groceries")).toBe(true);
  });

  it("pays an AA dinner and gets two equal shares back the next day", () => {
    const dinnerDay = days("2026-10-01", 20).find(date => epochDay(date) % 10 === 3)!;
    const dinner = planLifeDay(dinnerDay).find(event => event.slot === "aa-dinner")!;
    const backDay = days(dinnerDay, 2)[1];
    const back = planLifeDay(backDay).filter(event => event.kind === "friend-in");
    expect(back).toHaveLength(2);
    expect(new Set(back.map(event => event.friend)).size).toBe(2);
    expect(back[0].amountMinor).toBe(back[1].amountMinor);
    expect(back[0].amountMinor).toBe(Math.round(-dinner.amountMinor / 3 / 100) * 100);
    expect(back.map(event => event.label)).toEqual(back.map(event => `来自${{ chestnut: "小板栗", apple: "小苹果", watermelon: "小西瓜", orange: "小橘子" }[event.friend!]}的转账`));
  });

  it("always has a flagged purchase within any 14 days for the feed to find", () => {
    for (const start of days("2026-09-01", 60)) {
      expect(days(start, 14).some(date => planLifeDay(date).some(event => event.anomaly))).toBe(true);
    }
  });

  // 定投只是把活期挪进理财，不减少总资产；收入要覆盖其余的花销，账户才不会越过越空。
  it("keeps total assets from shrinking over a quarter", () => {
    const quarter = days("2026-10-01", 92).flatMap(planLifeDay);
    const income = quarter.filter(event => event.amountMinor > 0).reduce((sum, event) => sum + event.amountMinor, 0);
    const spent = quarter.filter(event => event.amountMinor < 0 && event.kind !== "invest").reduce((sum, event) => sum - event.amountMinor, 0);
    expect(spent).toBeLessThan(income);
  });
});
