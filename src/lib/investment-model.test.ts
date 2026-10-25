import { describe, expect, it } from "vitest";
import { addInvestmentDays, investmentFee, investmentPriceSeries, investmentRulesSchema, investmentShares, investmentValue } from "./investment-model";

const rules = investmentRulesSchema.parse({ kind: "FLEXIBLE", holdingDays: 0, purchaseFeeBps: 10, redemptionFeeBps: 5,
  driftBps: 240, volatilityBps: 8, seed: 207, epoch: "2026-01-01", modelVersion: "wealth-v1" });

describe("simulated investment pricing and money arithmetic", () => {
  it("replays identical prices and preserves old observations when the date advances", () => {
    const before = investmentPriceSeries(rules, "2026-10-22");
    expect(investmentPriceSeries(rules, "2026-10-22")).toEqual(before);
    const next = investmentPriceSeries(rules, "2026-10-23");
    expect(next.history.slice(0, -1)).toEqual(before.history.slice(1));
    expect(next.navMicros).not.toBe(before.navMicros);
    expect(before.history).toHaveLength(31);
  });
  it("includes losses in the scenario instead of synthesizing a guaranteed rising yield", () => {
    const history = investmentPriceSeries(rules, "2026-10-22", 295).history;
    expect(history.some((point, index) => index > 0 && point.navMicros < history[index - 1].navMicros)).toBe(true);
    expect(history.every(point => Number.isSafeInteger(point.navMicros) && point.navMicros > 0)).toBe(true);
    expect(investmentPriceSeries({ ...rules, seed: 208 }, "2026-10-22").navMicros).not.toBe(history.at(-1)!.navMicros);
  });
  it("uses cents and six-decimal shares with explicit fee and valuation rounding", () => {
    expect(investmentFee(10_000, 10)).toBe(10);
    expect(investmentFee(101, 5)).toBe(1);
    expect(investmentFee(101, 0)).toBe(0);
    expect(investmentShares(10_000, 10, 1_250_000)).toBe(79_920_000);
    expect(investmentValue(79_920_000, 1_250_000)).toBe(9_990);
    expect(investmentValue(79_920_000, 1_200_000)).toBe(9_590);
  });
  it("does not create money through fractional-share rounding at large or small amounts", () => {
    for (const amount of [100, 10001, 100_000_000]) {
      const fee = investmentFee(amount, 10);
      const shares = investmentShares(amount, fee, 1_234_567);
      const value = investmentValue(shares, 1_234_567);
      expect(Number.isSafeInteger(shares)).toBe(true);
      expect(value).toBeLessThanOrEqual(amount - fee);
      expect(amount - fee - value).toBeLessThanOrEqual(1);
    }
  });
  it("uses calendar days across month and leap-year boundaries", () => {
    expect(addInvestmentDays("2026-01-31", 30)).toBe("2026-03-02");
    expect(addInvestmentDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addInvestmentDays("2026-10-22", 90)).toBe("2027-01-20");
  });
  it.each(["2025-12-31", "2026-02-30", "2046-01-01", "not-a-date"])("rejects an unsupported valuation date: %s", day => {
    expect(() => investmentPriceSeries(rules, day)).toThrow("INVESTMENT_DATE_INVALID");
  });
});
