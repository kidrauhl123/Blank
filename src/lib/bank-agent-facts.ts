import { getBankingOverview } from "./bank-core";
import { getInvestmentOverview } from "./investments";
import { getBankStatement } from "./bank-statements";

export async function readBankFacts(customerId: string, area: "overview" | "investments" | "statement", month?: string) {
  if (area === "statement") return { capturedAt: new Date().toISOString(), statement: await getBankStatement(customerId, month) };
  if (area === "investments") {
    const data = await getInvestmentOverview(customerId);
    return { capturedAt: new Date().toISOString(), valuationDate: data.businessDate, valueMinor: data.valueMinor, profitMinor: data.profitMinor,
      products: data.products.map(product => ({ name: product.name, riskLevel: product.riskLevel, kind: product.kind, minimumMinor: product.minimumMinor, holdingDays: product.holdingDays, navMicros: product.navMicros, change30DaysPercent: product.change30DaysPercent, purchaseFeeBps: product.purchaseFeeBps, redemptionFeeBps: product.redemptionFeeBps })),
      positions: data.positions.map(position => ({ name: position.productName, valueMinor: position.valueMinor, costMinor: position.costMinor, profitMinor: position.profitMinor, unlocksOn: position.unlocksOn, redeemable: position.redeemable })) };
  }
  const data = await getBankingOverview(customerId);
  return { capturedAt: new Date().toISOString(), name: data.customer.display_name, totalMinor: data.totalMinor, investmentValueMinor: data.investmentValueMinor,
    accounts: data.accounts.map(account => ({ name: account.name, maskedNo: account.masked_no, availableBalanceMinor: account.available_balance_minor, currency: account.currency })),
    cards: data.cards.map(card => ({ name: card.card_name, maskedNo: card.masked_no, status: card.status, dailyLimitMinor: card.daily_limit_minor })),
    recentTransactions: data.transactions.slice(0, 12).map(item => ({ merchant: item.merchant_name, category: item.category, amountMinor: item.amount_minor, occurredAt: item.occurred_at, needsReview: item.is_anomaly })),
    subscriptions: data.subscriptions.map(item => ({ name: item.merchant_name, amountMinor: item.amount_minor, nextChargeAt: item.next_charge_at, status: item.status })) };
}
