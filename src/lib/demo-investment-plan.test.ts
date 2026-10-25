import { describe, expect, it } from "vitest";
import { DEMO_PROFILES } from "./demo-catalog";
import { buildDemoInvestmentPlan, type DemoInvestmentProduct } from "./demo-investment-plan";
import { investmentValue } from "./investment-model";

const products: DemoInvestmentProduct[] = [
  ["SIM-F01", "FLEXIBLE", "R1", 10000, 0, 0, 0, 180, 2, 101],
  ["SIM-F02", "FLEXIBLE", "R2", 100000, 0, 0, 5, 240, 8, 207],
  ["SIM-H30", "HOLDING", "R2", 100000, 30, 0, 5, 280, 10, 313],
  ["SIM-H60", "HOLDING", "R3", 500000, 60, 10, 10, 350, 35, 419],
  ["SIM-C90", "CLOSED", "R2", 100000, 90, 0, 0, 300, 12, 523],
  ["SIM-C180", "CLOSED", "R3", 1000000, 180, 10, 0, 400, 40, 631],
].map(([code, kind, risk, minimum, holding, purchaseFee, redemptionFee, drift, volatility, seed], index) => ({
  id: `product-${index}`, external_code: String(code), name: String(code), risk_level: String(risk), minimum_purchase_minor: String(minimum),
  facts: { kind: kind as "FLEXIBLE" | "HOLDING" | "CLOSED", holdingDays: Number(holding), purchaseFeeBps: Number(purchaseFee), redemptionFeeBps: Number(redemptionFee), driftBps: Number(drift), volatilityBps: Number(volatility), seed: Number(seed), epoch: "2026-01-01", modelVersion: "wealth-v1" },
}));

describe("preset investment cash flows", () => {
  it.each(DEMO_PROFILES.map(profile => profile.key))("reconciles %s purchases, redemption, funding and cash", key => {
    const plan = buildDemoInvestmentPlan(key, products, "2026-10-22");
    const movements = [plan.fundingMinor, -plan.closed.amountMinor, plan.redemption.settlementMinor, ...plan.holdings.map(lot => -lot.amountMinor)];
    let cash = 0;
    for (const movement of movements) { cash += movement; expect(cash).toBeGreaterThanOrEqual(0); }
    expect(cash).toBe(0);
    expect(plan.redemption.amountMinor).toBe(investmentValue(plan.closed.quantityMicro, plan.redemption.navMicros));
    expect(plan.redemption.settlementMinor + plan.redemption.feeMinor).toBe(plan.redemption.amountMinor);
    expect(plan.closed.purchasedOn <= plan.redemption.redeemedOn).toBe(true);
    expect(plan.redemption.redeemedOn >= plan.closed.unlocksOn).toBe(true);
    expect(plan.holdings.every(lot => lot.purchasedOn > plan.redemption.redeemedOn)).toBe(true);
    for (const lot of [plan.closed, ...plan.holdings]) {
      const allocated = lot.amountMinor - lot.feeMinor;
      const purchasedValue = investmentValue(lot.quantityMicro, lot.navMicros);
      expect(allocated - purchasedValue).toBeGreaterThanOrEqual(0);
      expect(allocated - purchasedValue).toBeLessThanOrEqual(1);
    }
  });
  it("covers all six products with two holdings and one closed investment per user", () => {
    const plans = DEMO_PROFILES.map(profile => buildDemoInvestmentPlan(profile.key, products, "2026-10-22"));
    expect(plans.every(plan => plan.holdings.length === 2)).toBe(true);
    expect(new Set(plans.flatMap(plan => plan.holdings.map(lot => lot.product.external_code))).size).toBe(6);
  });
  it("keeps the same money rules at the first simulation date and after a clock advance", () => {
    for (const date of ["2026-01-01", "2026-01-07", "2027-01-20"]) for (const profile of DEMO_PROFILES) {
      const plan = buildDemoInvestmentPlan(profile.key, products, date);
      expect(plan.fundingMinor - plan.closed.amountMinor + plan.redemption.settlementMinor - plan.holdings.reduce((sum, lot) => sum + lot.amountMinor, 0)).toBe(0);
      expect(plan.closed.purchasedOn >= "2026-01-01").toBe(true);
      expect(plan.holdings.every(lot => lot.purchasedOn <= date)).toBe(true);
    }
  });
});
