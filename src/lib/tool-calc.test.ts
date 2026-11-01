import { describe, expect, it } from "vitest";
import { formatYuan, friendShare, monthsToGoal, simulateSavings, splitSummaryText, splitTotals } from "./tool-calc";

// 2026-10-31 上午 10 点（北京时间），测试里的“现在”都用它。
const NOW = new Date("2026-10-31T10:00:00+08:00");

describe("monthsToGoal", () => {
  it("is zero once the goal is already reached, even with no saving", () => {
    expect(monthsToGoal(0, 0)).toBe(0);
    expect(monthsToGoal(-500, -100)).toBe(0);
  });
  it("is null when the monthly amount is zero or negative and the goal is still ahead", () => {
    expect(monthsToGoal(1000, 0)).toBeNull();
    expect(monthsToGoal(1000, -200)).toBeNull();
  });
  it("rounds the last partial month up", () => {
    expect(monthsToGoal(1000, 300)).toBe(4);
    expect(monthsToGoal(900, 300)).toBe(3);
  });
  it("treats more than 600 months as unreachable, and exactly 600 as reachable", () => {
    expect(monthsToGoal(600 * 100, 100)).toBe(600);
    expect(monthsToGoal(601 * 100, 100)).toBeNull();
  });
});

describe("simulateSavings", () => {
  it("gives the earlier months and both departure months", () => {
    const result = simulateSavings({ targetMinor: 1_000_000, savedMinor: 0, baseMonthlyMinor: 50_000 }, 50_000, NOW);
    expect(result.baselineMonths).toBe(20);
    expect(result.months).toBe(10);
    expect(result.monthsEarlier).toBe(10);
    expect(result.departure).toEqual({ year: 2027, month: 8 });
    expect(result.baselineDeparture).toEqual({ year: 2028, month: 6 });
  });
  it("rolls the departure over the year boundary", () => {
    const november = new Date("2026-11-05T09:00:00+08:00");
    const result = simulateSavings({ targetMinor: 300_000, savedMinor: 0, baseMonthlyMinor: 100_000 }, 0, november);
    expect(result.baselineMonths).toBe(3);
    expect(result.baselineDeparture).toEqual({ year: 2027, month: 2 });
  });
  it("counts months in Beijing time, not UTC", () => {
    const reached = { targetMinor: 100, savedMinor: 100, baseMonthlyMinor: 0 };
    // 北京时间 2026-11-01 00:00 已经是十一月，UTC 还在十月 31 日。
    expect(simulateSavings(reached, 0, new Date("2026-10-31T16:00:00Z")).departure).toEqual({ year: 2026, month: 11 });
    // 北京时间 2026-10-31 23:59 仍是十月。
    expect(simulateSavings(reached, 0, new Date("2026-10-31T15:59:00Z")).departure).toEqual({ year: 2026, month: 10 });
  });
  it("reports zero months earlier when the goal is already reached", () => {
    const result = simulateSavings({ targetMinor: 10_000, savedMinor: 12_000, baseMonthlyMinor: 5_000 }, 5_000, NOW);
    expect(result.baselineMonths).toBe(0);
    expect(result.months).toBe(0);
    expect(result.monthsEarlier).toBe(0);
    expect(result.departure).toEqual({ year: 2026, month: 10 });
  });
  it("gives null monthsEarlier when the baseline never arrives but the extra saving does", () => {
    const result = simulateSavings({ targetMinor: 100_000, savedMinor: 0, baseMonthlyMinor: 0 }, 10_000, NOW);
    expect(result.baselineMonths).toBeNull();
    expect(result.months).toBe(10);
    expect(result.monthsEarlier).toBeNull();
    expect(result.baselineDeparture).toBeNull();
    expect(result.departure).toEqual({ year: 2027, month: 8 });
  });
  it("gives nulls everywhere when neither the baseline nor the adjusted plan arrives", () => {
    const result = simulateSavings({ targetMinor: 100_000, savedMinor: 0, baseMonthlyMinor: -100 }, 0, NOW);
    expect(result.months).toBeNull();
    expect(result.monthsEarlier).toBeNull();
    expect(result.departure).toBeNull();
  });
  it("treats a goal that needs more than 600 months as unreachable", () => {
    const result = simulateSavings({ targetMinor: 1_000_000, savedMinor: 0, baseMonthlyMinor: 100 }, 0, NOW);
    expect(result.baselineMonths).toBeNull();
    expect(result.months).toBeNull();
  });
  it("keeps the curve on the target once reached and flat when there is no growth", () => {
    const grows = simulateSavings({ targetMinor: 1_000_000, savedMinor: 0, baseMonthlyMinor: 50_000 }, 50_000, NOW);
    expect(grows.curve.find(point => point.month === 15)).toEqual({ month: 15, baseline: 750_000, adjusted: 1_000_000 });
    const flat = simulateSavings({ targetMinor: 100_000, savedMinor: 20_000, baseMonthlyMinor: -500 }, 0, NOW);
    expect(flat.curve.every(point => point.baseline === 20_000 && point.adjusted === 20_000)).toBe(true);
  });
  it("starts the curve at the saved amount, one point per month when short", () => {
    const result = simulateSavings({ targetMinor: 1_000_000, savedMinor: 100_000, baseMonthlyMinor: 100_000 }, 0, NOW);
    expect(result.curve.map(point => point.month)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.curve[0]).toEqual({ month: 0, baseline: 100_000, adjusted: 100_000 });
    expect(result.curve.at(-1)).toEqual({ month: 9, baseline: 1_000_000, adjusted: 1_000_000 });
    expect(result.curve.every(point => point.baseline <= 1_000_000 && point.adjusted <= 1_000_000)).toBe(true);
  });
  it("always draws at least 6 months, even when the goal is reached at once", () => {
    const result = simulateSavings({ targetMinor: 100_000, savedMinor: 0, baseMonthlyMinor: 100_000 }, 0, NOW);
    expect(result.curve.map(point => point.month)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("caps a long curve at 60 points and keeps both finishing months as points", () => {
    const result = simulateSavings({ targetMinor: 1_000_000, savedMinor: 0, baseMonthlyMinor: 2_000 }, 1_000, NOW);
    const months = result.curve.map(point => point.month);
    expect(result.baselineMonths).toBe(500);
    expect(result.months).toBe(334);
    expect(result.curve.length).toBeLessThanOrEqual(60);
    expect(months).toContain(334);
    expect(months.at(-1)).toBe(500);
    expect(months.every((month, index) => index === 0 || month > months[index - 1])).toBe(true);
    expect(result.curve.every(point => point.baseline <= 1_000_000 && point.adjusted <= 1_000_000)).toBe(true);
  });
});

describe("friendShare", () => {
  it("splits an odd amount with the extra cent on my side", () => {
    expect(friendShare(101, "split")).toBe(50);
    expect(friendShare(100, "split")).toBe(50);
  });
  it("gives nothing for my treat and the full amount for hers", () => {
    expect(friendShare(101, "mine")).toBe(0);
    expect(friendShare(101, "hers")).toBe(101);
  });
});

describe("splitTotals", () => {
  it("treats rows without a chosen mode as split", () => {
    const totals = splitTotals([{ id: "a", amountMinor: 10_000 }, { id: "b", amountMinor: 5_001 }], {}, 0);
    expect(totals.friendOwesMinor).toBe(7_500);
    expect(totals.counts).toEqual({ split: 2, mine: 0, hers: 0 });
    expect(totals.remainingMinor).toBe(7_500);
    expect(totals.paidByMeMinor).toBe(15_001);
  });
  it("adds up a mix of the three modes", () => {
    const rows = [{ id: "a", amountMinor: 10_000 }, { id: "b", amountMinor: 5_000 }, { id: "c", amountMinor: 3_000 }];
    const totals = splitTotals(rows, { a: "split", b: "mine", c: "hers" }, 1_000);
    expect(totals).toEqual({ friendOwesMinor: 8_000, receivedMinor: 1_000, remainingMinor: 7_000, counts: { split: 1, mine: 1, hers: 1 }, paidByMeMinor: 18_000 });
  });
  it("goes negative when she has already transferred more than she owes", () => {
    const totals = splitTotals([{ id: "a", amountMinor: 10_000 }], { a: "split" }, 8_000);
    expect(totals.friendOwesMinor).toBe(5_000);
    expect(totals.remainingMinor).toBe(-3_000);
  });
  it("handles an empty bill", () => {
    expect(splitTotals([], {}, 0)).toEqual({ friendOwesMinor: 0, receivedMinor: 0, remainingMinor: 0, counts: { split: 0, mine: 0, hers: 0 }, paidByMeMinor: 0 });
  });
});

describe("splitSummaryText", () => {
  const rows = [{ id: "a", amountMinor: 10_000 }, { id: "b", amountMinor: 5_000 }, { id: "c", amountMinor: 3_000 }];
  const modes = { a: "split", b: "mine", c: "hers" } as const;
  it("says how much she still owes me", () => {
    expect(splitSummaryText("小橘子", 3, splitTotals(rows, modes, 1_000))).toBe("和小橘子的分账：共3笔，平摊1笔，我请1笔，她的1笔，她应付 ¥80，她已转我 ¥10，她还需转我 ¥70。");
  });
  it("says I owe her back when she transferred too much", () => {
    expect(splitSummaryText("小橘子", 3, splitTotals(rows, modes, 10_000))).toContain("我还需转她 ¥20。");
  });
  it("says it is settled when the two sides match", () => {
    expect(splitSummaryText("小橘子", 3, splitTotals(rows, modes, 8_000))).toMatch(/已经算清了。$/);
  });
});

describe("formatYuan", () => {
  it("prints whole yuan without decimals", () => {
    expect(formatYuan(0)).toBe("¥0");
    expect(formatYuan(123_400)).toBe("¥1,234");
    expect(formatYuan(100_000_000)).toBe("¥1,000,000");
  });
  it("shows the cents only when there are some, dropping a trailing zero", () => {
    expect(formatYuan(123_450)).toBe("¥1,234.5");
    expect(formatYuan(123_405)).toBe("¥1,234.05");
    expect(formatYuan(1)).toBe("¥0.01");
    expect(formatYuan(10)).toBe("¥0.1");
  });
  it("puts the minus sign in front of the currency symbol", () => {
    expect(formatYuan(-5_000)).toBe("-¥50");
    expect(formatYuan(-1)).toBe("-¥0.01");
  });
});
