import { z } from "zod";

export const investmentRulesSchema = z.object({
  kind: z.enum(["FLEXIBLE", "HOLDING", "CLOSED"]),
  holdingDays: z.number().int().min(0).max(3650),
  purchaseFeeBps: z.number().int().min(0).max(100),
  redemptionFeeBps: z.number().int().min(0).max(100),
  driftBps: z.number().int().min(-1000).max(1000),
  volatilityBps: z.number().int().min(1).max(100),
  seed: z.number().int().min(1).max(1_000_000),
  epoch: z.literal("2026-01-01"),
  modelVersion: z.literal("wealth-v1"),
});
export type InvestmentRules = z.infer<typeof investmentRulesSchema>;
export type InvestmentKind = InvestmentRules["kind"];
export type InvestmentRisk = "R1" | "R2" | "R3" | "R4" | "R5";
export const investmentKindLabels: Record<InvestmentKind, string> = { FLEXIBLE: "灵活申赎", HOLDING: "最低持有期", CLOSED: "封闭期限" };
export const NAV_SCALE = 1_000_000;
export const SHARE_SCALE = 1_000_000;
const VALUE_SCALE = BigInt(10_000_000_000);

export function addInvestmentDays(day: string, count: number) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

// Integer prices are a repeatable scenario, not an annual return promise.
export function investmentPriceSeries(rules: InvestmentRules, day: string, points = 31) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > "2045-12-31") throw new Error("INVESTMENT_DATE_INVALID");
  const days = Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${rules.epoch}T00:00:00Z`)) / 86_400_000);
  if (!Number.isSafeInteger(days) || days < 0 || addInvestmentDays(rules.epoch, days) !== day) throw new Error("INVESTMENT_DATE_INVALID");
  let price = NAV_SCALE;
  let state = rules.seed >>> 0;
  const history: Array<{ date: string; navMicros: number }> = [];
  for (let index = 0; index <= days; index++) {
    if (index > 0) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const shock = state % (rules.volatilityBps * 2 + 1) - rules.volatilityBps;
      const change = BigInt(price) * BigInt(rules.driftBps + shock * 365) / BigInt(3_650_000);
      price = Math.max(1, price + Number(change));
    }
    if (index > days - points) history.push({ date: addInvestmentDays(rules.epoch, index), navMicros: price });
  }
  return { navMicros: price, history };
}

export function investmentFee(amountMinor: number, feeBps: number) {
  return Number((BigInt(amountMinor) * BigInt(feeBps) + BigInt(9999)) / BigInt(10_000));
}
export function investmentShares(amountMinor: number, feeMinor: number, navMicros: number) {
  const result = Number(BigInt(amountMinor - feeMinor) * VALUE_SCALE / BigInt(navMicros));
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("INVESTMENT_VALUE_INVALID");
  return result;
}
export function investmentValue(quantityMicro: number, navMicros: number) {
  const result = Number(BigInt(quantityMicro) * BigInt(navMicros) / VALUE_SCALE);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("INVESTMENT_VALUE_INVALID");
  return result;
}
