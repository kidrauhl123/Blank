import type { InvestmentKind, InvestmentRisk } from "./investment-model";

export type InvestmentProduct = {
  id: string; code: string; name: string; issuer: string; kind: InvestmentKind;
  riskLevel: InvestmentRisk; minimumMinor: number; holdingDays: number;
  purchaseFeeBps: number; redemptionFeeBps: number; status: string;
  navMicros: number; change30DaysPercent: number;
  history: Array<{ date: string; navMicros: number }>;
  simulated: true; source: string;
};
export type InvestmentPosition = {
  id: string; productId: string; productName: string; quantityMicro: number;
  costMinor: number; valueMinor: number; profitMinor: number;
  purchasedOn: string; unlocksOn: string; redeemable: boolean;
};
export type InvestmentOverview = {
  businessDate: string; products: InvestmentProduct[]; positions: InvestmentPosition[];
  history: InvestmentHistoryEntry[];
  valueMinor: number; profitMinor: number; cashMinor: number;
  assessment: { riskLevel: InvestmentRisk; expiresAt: string } | null;
};
export type InvestmentHistoryEntry = { receipt: InvestmentReceipt; executedAt: string; source: "DEMO_SEED" | "USER" };
export type InvestmentQuote = {
  side: "SUBSCRIBE" | "REDEEM"; customerId: string; productId: string; productName: string;
  productVersion: number; accountId: string; accountMaskedNo: string; positionId: string | null;
  businessDate: string; navMicros: number; quantityMicro: number; amountMinor: number;
  feeMinor: number; settlementMinor: number; unlocksOn: string; riskLevel: InvestmentRisk;
  assessmentId: string | null; requiredAuth: "MFA" | "CONFIRM"; termsDigest: string;
};
export type InvestmentReceipt = {
  operationId: string; status: "SUCCEEDED"; side: InvestmentQuote["side"];
  productName: string; amountMinor: number; feeMinor: number; settlementMinor: number;
  quantityMicro: number; navMicros: number; businessDate: string; positionId: string;
  ledgerReference: string;
};
export type InvestmentOrder = {
  operationId: string; status: string; expiresAt: string; quote: InvestmentQuote;
  receipt: InvestmentReceipt | null;
};
