import { z } from "zod";
import type { AgentUnderstanding } from "./ai";

export type BankReplyInput = {
  userMessage: string;
  intent: AgentUnderstanding["intent"];
  state: "COMPLETED" | "AWAITING_INPUT" | "AWAITING_CONFIRMATION" | "AWAITING_MFA";
  facts: Record<string, unknown>;
};

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(200);
const transfer = z.object({ amountMinor: minor.positive(), currency: z.literal("CNY"), recipient: z.object({ name }) });
const unverified = "银行结果尚未核实，请查看银行页面回执。";
const money = (value: number) => `${(value / 100).toFixed(2)} 元`;
// Quote free-form labels as data. Never render modelClarification, user text or
// a model-selected message as an authoritative amount/status.
const label = (value: string) => JSON.stringify(value);

export function renderBankReply({ intent, state, facts }: BankReplyInput): { message: string; suggestions: string[] } {
  if (facts.operationExecuted === true && state !== "COMPLETED") return { message: unverified, suggestions: [] };
  if (state === "COMPLETED" && facts.operationState === "CANCELLED" && facts.operationExecuted === false) {
    return { message: "操作已取消，银行未执行该操作。", suggestions: [] };
  }
  if (state === "AWAITING_INPUT") {
    const missing = z.array(z.string()).safeParse(facts.missingFields);
    const fields: Record<string, string> = { amount: "转账金额", beneficiary: "收款人", validSourceAccount: "可用的付款账户" };
    const required = missing.success ? missing.data.map(key => fields[key]).filter(Boolean) : [];
    return { message: required.length ? `请补充${required.join("、")}，当前操作尚未执行。`
      : intent === "CARD_LOCK" ? "没有找到可操作的卡片，请先在卡片页面核对。"
        : "你想查询余额、分析账单、转账、查看订阅，还是管理卡片？", suggestions: [] };
  }
  if (intent === "TRANSFER") {
    const details = transfer.safeParse(facts);
    if (!details.success) return { message: unverified, suggestions: [] };
    const summary = `向${label(details.data.recipient.name)}转账 ${money(details.data.amountMinor)}`;
    if (state === "COMPLETED" && facts.operationState === "SUCCEEDED" && facts.operationExecuted === true) {
      return { message: `${summary}已完成，银行已记账。`, suggestions: ["查看余额"] };
    }
    if (facts.operationExecuted === false && facts.operationState === "PREPARED_NOT_EXECUTED"
      && ["AWAITING_CONFIRMATION", "AWAITING_MFA"].includes(state)) {
      return { message: `${summary}的草稿已准备，资金未转出。${state === "AWAITING_MFA" ? "请回银行 APP 核对详情并验证动态码。" : "请核对详情后明确确认。"}`, suggestions: [] };
    }
    return { message: unverified, suggestions: [] };
  }
  if (intent === "CARD_LOCK") {
    const card = z.object({ cardName: name, maskedNo: name }).safeParse(facts);
    if (!card.success) return { message: unverified, suggestions: [] };
    if (state === "COMPLETED" && facts.operationState === "SUCCEEDED" && facts.operationExecuted === true && facts.cardStatus === "LOCKED") {
      return { message: `卡片${label(card.data.cardName)}（${card.data.maskedNo}）已锁定。`, suggestions: [] };
    }
    if (state === "AWAITING_CONFIRMATION" && facts.operationState === "PREPARED_NOT_EXECUTED" && facts.operationExecuted === false) {
      return { message: `准备锁定卡片${label(card.data.cardName)}（${card.data.maskedNo}），尚未执行。请核对后确认。`, suggestions: [] };
    }
    return { message: unverified, suggestions: [] };
  }
  if (state !== "COMPLETED") return { message: unverified, suggestions: [] };
  if (intent === "INVESTMENTS") {
    const catalog = z.object({ simulated: z.literal(true), businessDate: name, products: z.array(z.object({ name, riskLevel: z.enum(["R1", "R2", "R3", "R4", "R5"]), minimumMinor: minor, holdingDays: minor })) }).safeParse(facts);
    if (!catalog.success) return { message: unverified, suggestions: [] };
    const products = catalog.data.products.map(product => `${label(product.name)}：${product.riskLevel}，${money(product.minimumMinor)}起购，${product.holdingDays ? `持有${product.holdingDays}天后可赎回` : "灵活申赎"}`).join("；");
    return { message: `理财目录（${label(catalog.data.businessDate)}）：${products || "没有符合条件的产品"}。请回银行 APP 的理财页比较与办理，申购需风险测评和本人强验证。本次未执行交易。`, suggestions: [] };
  }
  if (intent === "BALANCE") {
    const balance = z.object({ totalAvailableBalanceMinor: minor, currency: z.literal("CNY"),
      accounts: z.array(z.object({ name, maskedNo: name, availableBalanceMinor: minor })) }).safeParse(facts);
    if (!balance.success || balance.data.accounts.reduce((sum, account) => sum + account.availableBalanceMinor, 0) !== balance.data.totalAvailableBalanceMinor) {
      return { message: unverified, suggestions: [] };
    }
    return { message: `账户可用余额合计 ${money(balance.data.totalAvailableBalanceMinor)}。`, suggestions: ["分析本月账单"] };
  }
  if (intent === "BILL_ANALYSIS") {
    const bill = z.object({ analyzedRange: name, totalExpenseMinor: minor, currency: z.literal("CNY"),
      categories: z.array(z.object({ category: name, totalMinor: minor })), anomalies: z.array(z.unknown()) }).safeParse(facts);
    if (!bill.success || bill.data.categories.reduce((sum, category) => sum + category.totalMinor, 0) !== bill.data.totalExpenseMinor) {
      return { message: unverified, suggestions: [] };
    }
    const categories = bill.data.categories.slice(0, 3).map(category => `${label(category.category)} ${money(category.totalMinor)}`).join("、");
    return { message: `${label(bill.data.analyzedRange)}支出合计 ${money(bill.data.totalExpenseMinor)}。${categories ? `主要分类：${categories}。` : "当前范围没有支出记录。"}本次返回的异常标记 ${bill.data.anomalies.length} 笔。`, suggestions: ["查看余额"] };
  }
  if (intent === "SUBSCRIPTIONS") {
    const subscriptions = z.object({ activeSubscriptionCount: minor, normalizedMonthlyCostMinor: minor,
      currency: z.literal("CNY"), cancellationStatus: z.literal("NOT_REQUESTED") }).safeParse(facts);
    if (!subscriptions.success) return { message: unverified, suggestions: [] };
    return { message: `当前有 ${subscriptions.data.activeSubscriptionCount} 项有效订阅，折合月支出 ${money(subscriptions.data.normalizedMonthlyCostMinor)}。本次仅查询，未取消订阅或停止代扣。`, suggestions: [] };
  }
  return { message: unverified, suggestions: [] };
}
