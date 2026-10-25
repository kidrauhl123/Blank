import { DEMO_PROFILES } from "./demo-catalog";
import { addInvestmentDays, investmentFee, investmentPriceSeries, investmentRulesSchema, investmentShares, investmentValue, type InvestmentRules } from "./investment-model";

type ProfileKey = (typeof DEMO_PROFILES)[number]["key"];
type Purchase = { code: string; amountMinor: number; daysAgo: number };
type History = { holdings: Purchase[]; redeemed: Purchase & { redeemedDaysAgo: number } };
export const DEMO_INVESTMENT_PLANS: Record<ProfileKey, History> = {
  potato: { holdings: [{ code: "SIM-F01", amountMinor: 100000, daysAgo: 20 }, { code: "SIM-H30", amountMinor: 300000, daysAgo: 12 }], redeemed: { code: "SIM-F02", amountMinor: 200000, daysAgo: 55, redeemedDaysAgo: 50 } },
  chestnut: { holdings: [{ code: "SIM-F01", amountMinor: 20000, daysAgo: 8 }, { code: "SIM-H30", amountMinor: 100000, daysAgo: 45 }], redeemed: { code: "SIM-F01", amountMinor: 50000, daysAgo: 55, redeemedDaysAgo: 50 } },
  apple: { holdings: [{ code: "SIM-H60", amountMinor: 1500000, daysAgo: 45 }, { code: "SIM-C180", amountMinor: 3000000, daysAgo: 20 }], redeemed: { code: "SIM-F02", amountMinor: 1000000, daysAgo: 55, redeemedDaysAgo: 50 } },
  watermelon: { holdings: [{ code: "SIM-F02", amountMinor: 500000, daysAgo: 8 }, { code: "SIM-H60", amountMinor: 1000000, daysAgo: 35 }], redeemed: { code: "SIM-F02", amountMinor: 300000, daysAgo: 55, redeemedDaysAgo: 50 } },
  orange: { holdings: [{ code: "SIM-C90", amountMinor: 1000000, daysAgo: 40 }, { code: "SIM-H30", amountMinor: 500000, daysAgo: 15 }], redeemed: { code: "SIM-F01", amountMinor: 300000, daysAgo: 55, redeemedDaysAgo: 50 } },
};
export type DemoInvestmentProduct = { id: string; external_code: string; name: string; risk_level: string; minimum_purchase_minor: string; facts: InvestmentRules };

export function buildDemoInvestmentPlan(profileKey: ProfileKey, products: DemoInvestmentProduct[], day: string) {
  const config = DEMO_INVESTMENT_PLANS[profileKey];
  const dateAgo = (days: number) => {
    const date = addInvestmentDays(day, -days);
    return date < "2026-01-01" ? "2026-01-01" : date;
  };
  const purchase = (item: Purchase, key: string) => {
    const product = products.find(product => product.external_code === item.code);
    if (!product || item.amountMinor < Number(product.minimum_purchase_minor)) throw new Error("DEMO_INVESTMENT_PRODUCT_MISSING");
    const terms = investmentRulesSchema.parse(product.facts);
    const purchasedOn = dateAgo(item.daysAgo);
    const navMicros = investmentPriceSeries(terms, purchasedOn).navMicros;
    const feeMinor = investmentFee(item.amountMinor, terms.purchaseFeeBps);
    return { key, product, terms, purchasedOn, unlocksOn: addInvestmentDays(purchasedOn, terms.holdingDays), navMicros,
      amountMinor: item.amountMinor, feeMinor, quantityMicro: investmentShares(item.amountMinor, feeMinor, navMicros) };
  };
  const closed = purchase(config.redeemed, "past");
  const redeemedOn = dateAgo(config.redeemed.redeemedDaysAgo);
  if (redeemedOn < closed.unlocksOn) throw new Error("DEMO_INVESTMENT_HISTORY_LOCKED");
  const redemptionNav = investmentPriceSeries(closed.terms, redeemedOn).navMicros;
  const redemptionAmount = investmentValue(closed.quantityMicro, redemptionNav);
  const redemptionFee = investmentFee(redemptionAmount, closed.terms.redemptionFeeBps);
  const redemption = { redeemedOn, navMicros: redemptionNav, amountMinor: redemptionAmount, feeMinor: redemptionFee, settlementMinor: redemptionAmount - redemptionFee };
  const holdings = config.holdings.map((item, index) => purchase(item, `holding-${index + 1}`));
  // An explicit historical capital allocation funds the portfolio while the
  // added cash entries net to zero, even for an already-spent demo account.
  const fundingMinor = holdings.reduce((sum, item) => sum + item.amountMinor, 0) + closed.amountMinor - redemption.settlementMinor;
  if (!Number.isSafeInteger(fundingMinor) || fundingMinor < closed.amountMinor) throw new Error("DEMO_INVESTMENT_FUNDING_INVALID");
  return { fundingMinor, fundedOn: dateAgo(60), closed, redemption, holdings };
}
